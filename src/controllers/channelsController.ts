import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import telegramService from "../services/telegram";

const DEFAULT_COVER_URL =
  "https://cdn.qepal.com/qeupload/6759d578be4c8e9471a45c81/download22jpg-ghyhvjsfacjurgu04sjd2zog0rzk1e.jpg";

// ── GET /api/channels ──────────────────────────────────────────
export const getUserChannels = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id;
    const db = mongoose.connection.db;
    const channels = await db
      .collection("telegram_channels")
      .find({ userId: userId.toString() })
      .sort({ addedAt: -1 })
      .toArray();
    res.json({ success: true, data: channels });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/channels ─────────────────────────────────────────
export const addChannel = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id;
    const { channelUsername, channelName } = req.body;
    if (!channelUsername || !channelName) {
      return res
        .status(400)
        .json({ success: false, msg: "channelUsername and channelName required" });
    }

    const db = mongoose.connection.db;
    const username = channelUsername.replace("@", "");
    const exists = await db.collection("telegram_channels").findOne({
      userId: userId.toString(),
      channelUsername: username,
    });
    if (exists)
      return res
        .status(400)
        .json({ success: false, msg: "Channel already added" });

    const photoUrl = await telegramService.getChannelPhoto(username, userId);

    const newChannel = {
      userId: userId.toString(),
      channelUsername: username,
      channelName,
      photoUrl,
      status: "pending",
      songsCount: 0,
      addedAt: new Date(),
    };

    const result = await db.collection("telegram_channels").insertOne(newChannel);
    const channelDbId = result.insertedId.toString();

    // ── Respond immediately, then sync in background ───────────
    res.status(201).json({
      success: true,
      msg: "Channel added. Sync started in background.",
      data: { _id: result.insertedId, ...newChannel },
    });

    // Background sync — не блокирует ответ
    _syncInBackground(channelDbId, username, userId, db).catch((err) => {
      console.error(`Background sync failed for ${username}:`, err);
    });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/channels/:id ───────────────────────────────────
export const removeChannel = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id;
    const channelDbId = req.params.id;
    const db = mongoose.connection.db;

    const channel = await db.collection("telegram_channels").findOne({
      _id: new mongoose.Types.ObjectId(channelDbId),
      userId: userId.toString(),
    });
    if (!channel)
      return res
        .status(404)
        .json({ success: false, msg: "Channel not found" });

    await db
      .collection("telegram_channels")
      .deleteOne({ _id: new mongoose.Types.ObjectId(channelDbId) });
    await db
      .collection("telegram_songs")
      .deleteMany({ channelDbId });

    res.json({
      success: true,
      msg: `Channel "${channel.channelName}" removed`,
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/channels/:id/sync ────────────────────────────────
// Now returns immediately with { syncing: true } and processes in background.
// Flutter should poll GET /api/channels to detect when status changes to "active".
export const syncChannel = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id;
    const channelDbId = req.params.id;
    const { channelUsername, forceFullSync } = req.body;

    const db = mongoose.connection.db;

    // Check channel exists
    const channel = await db.collection("telegram_channels").findOne({
      _id: new mongoose.Types.ObjectId(channelDbId),
      userId: userId.toString(),
    });
    if (!channel) {
      return res
        .status(404)
        .json({ success: false, msg: "Channel not found" });
    }

    // If already syncing, don't start another one
    if (channel.status === "syncing") {
      return res.json({
        success: true,
        syncing: true,
        msg: "Sync already in progress",
      });
    }

    // Mark as syncing immediately
    await db.collection("telegram_channels").updateOne(
      { _id: new mongoose.Types.ObjectId(channelDbId) },
      { $set: { status: "syncing" } }
    );

    const username = (channelUsername || channel.channelUsername || "").replace(
      "@",
      ""
    );

    // Respond to client right away — don't wait for sync
    res.json({
      success: true,
      syncing: true,
      msg: "Sync started. Poll GET /api/channels to check progress.",
    });

    // Background sync
    _syncInBackground(
      channelDbId,
      username,
      userId,
      db,
      forceFullSync
    ).catch((err) => {
      console.error(`Background sync failed for ${username}:`, err);
      // Mark as error
      db.collection("telegram_channels")
        .updateOne(
          { _id: new mongoose.Types.ObjectId(channelDbId) },
          { $set: { status: "error" } }
        )
        .catch(() => {});
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/channels/:id/sync-status ─────────────────────────
// Flutter polls this to know when sync is done.
export const getSyncStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id;
    const channelDbId = req.params.id;
    const db = mongoose.connection.db;

    const channel = await db.collection("telegram_channels").findOne({
      _id: new mongoose.Types.ObjectId(channelDbId),
      userId: userId.toString(),
    });

    if (!channel) {
      return res
        .status(404)
        .json({ success: false, msg: "Channel not found" });
    }

    res.json({
      success: true,
      status: channel.status,       // "pending" | "syncing" | "active" | "error"
      songsCount: channel.songsCount || 0,
      lastSync: channel.lastSync || null,
    });
  } catch (error) {
    next(error);
  }
};

// ── Background sync implementation ────────────────────────────
async function _syncInBackground(
  channelDbId: string,
  username: string,
  userId: any,
  db: any,
  forceFullSync: boolean = false
): Promise<void> {
  console.log(`🚀 [bg-sync] Starting sync for ${username} (channelDbId=${channelDbId})`);

  // Find last messageId for incremental sync
  let lastMessageId = 0;
  if (!forceFullSync) {
    const latestSong = await db
      .collection("telegram_songs")
      .find({ channelDbId })
      .sort({ messageId: -1 })
      .limit(1)
      .toArray();
    if (latestSong.length > 0) {
      lastMessageId = latestSong[0].messageId;
      console.log(`[bg-sync] Incremental from messageId=${lastMessageId}`);
    }
  }

  // If full sync requested, delete existing songs first
  if (forceFullSync) {
    await db.collection("telegram_songs").deleteMany({ channelDbId });
    console.log(`[bg-sync] Cleared old songs for full sync`);
  }

  // Fetch from Telegram (may take minutes on large channels)
  const result = await telegramService.getChannelAudioFiles(
    username,
    userId,
    lastMessageId
  );

  if (!result.success || !result.files) {
    await db.collection("telegram_channels").updateOne(
      { _id: new mongoose.Types.ObjectId(channelDbId) },
      { $set: { status: "error" } }
    );
    console.error(`[bg-sync] Failed for ${username}: ${result.error}`);
    return;
  }

  console.log(`[bg-sync] Got ${result.files.length} new files for ${username}`);

  if (result.files.length > 0) {
    // Upsert in batches of 100 to avoid oversized bulkWrite calls
    const BATCH = 100;
    for (let i = 0; i < result.files.length; i += BATCH) {
      const batch = result.files.slice(i, i + BATCH);
      const bulkOps = batch.map((file) => ({
        updateOne: {
          filter: { channelDbId, messageId: file.messageId },
          update: {
            $set: {
              channelDbId,
              channelUsername: username,
              title: file.title,
              artist: file.artist,
              duration: file.duration,
              fileId: file.fileId,
              fileSize: file.fileSize,
              mimeType: file.mimeType,
              messageId: file.messageId,
              messageDate: new Date(file.messageDate * 1000),
              fileUrl: file.fileUrl,
              thumbnail: file.thumbnail || DEFAULT_COVER_URL,
              format: file.mimeType?.includes("mp3") ? "mp3" : "audio",
            },
          },
          upsert: true,
        },
      }));
      await db.collection("telegram_songs").bulkWrite(bulkOps, { ordered: false });
      console.log(
        `[bg-sync] Upserted batch ${i / BATCH + 1} / ${Math.ceil(result.files.length / BATCH)}`
      );
    }
  }

  // Update total count and mark active
  const totalSongs = await db
    .collection("telegram_songs")
    .countDocuments({ channelDbId });

  // Refresh channel photo
  let photoUrl: string | null = null;
  try {
    photoUrl = await telegramService.getChannelPhoto(username, userId);
  } catch (_) {}

  await db.collection("telegram_channels").updateOne(
    { _id: new mongoose.Types.ObjectId(channelDbId) },
    {
      $set: {
        status: "active",
        songsCount: totalSongs,
        lastSync: new Date(),
        ...(photoUrl ? { photoUrl } : {}),
      },
    }
  );

  console.log(
    `✅ [bg-sync] Done for ${username}: ${totalSongs} total songs (${result.files.length} new)`
  );

  // Download thumbnails in background (non-blocking, limit to 30)
  const thumbLimit = Math.min(result.files.length, 30);
  setImmediate(async () => {
    for (let i = 0; i < thumbLimit; i++) {
      const file = result.files![i];
      if (file.thumbnail && file.thumbnail !== DEFAULT_COVER_URL) continue;
      try {
        const thumbnail = await telegramService.downloadSongThumbnail(
          username,
          file.messageId,
          userId
        );
        if (thumbnail) {
          await db.collection("telegram_songs").updateOne(
            { channelDbId, messageId: file.messageId },
            { $set: { thumbnail } }
          );
        }
      } catch (err) {
        // Non-fatal
      }
    }
  });
}