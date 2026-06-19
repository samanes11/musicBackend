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

    const channels = await mongoose.connection.db
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

    // unique index handles duplicates — but give a friendly message
    const exists = await db.collection("telegram_channels").findOne({
      userId: userId.toString(),
      channelUsername: username,
    });
    if (exists)
      return res.status(400).json({ success: false, msg: "Channel already added" });

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

    res.status(201).json({
      success: true,
      msg: "Channel added. Sync started in background.",
      data: { _id: result.insertedId, ...newChannel },
    });

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
      return res.status(404).json({ success: false, msg: "Channel not found" });

    await db
      .collection("telegram_channels")
      .deleteOne({ _id: new mongoose.Types.ObjectId(channelDbId) });

    // channelDbId stored as string in telegram_songs
    await db.collection("telegram_songs").deleteMany({ channelDbId });

    res.json({ success: true, msg: `Channel "${channel.channelName}" removed` });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/channels/:id/sync ────────────────────────────────
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

    const channel = await db.collection("telegram_channels").findOne({
      _id: new mongoose.Types.ObjectId(channelDbId),
      userId: userId.toString(),
    });
    if (!channel)
      return res.status(404).json({ success: false, msg: "Channel not found" });

    if (channel.status === "syncing") {
      return res.json({ success: true, syncing: true, msg: "Sync already in progress" });
    }

    await db.collection("telegram_channels").updateOne(
      { _id: new mongoose.Types.ObjectId(channelDbId) },
      { $set: { status: "syncing" } }
    );

    const username = (channelUsername || channel.channelUsername || "").replace("@", "");

    res.json({ success: true, syncing: true, msg: "Sync started." });

    _syncInBackground(channelDbId, username, userId, db, forceFullSync).catch((err) => {
      console.error(`Background sync failed for ${username}:`, err);
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
export const getSyncStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id;
    const channelDbId = req.params.id;
    const db = mongoose.connection.db;

    const channel = await db.collection("telegram_channels").findOne(
      {
        _id: new mongoose.Types.ObjectId(channelDbId),
        userId: userId.toString(),
      },
      { projection: { status: 1, songsCount: 1, lastSync: 1 } }
    );

    if (!channel)
      return res.status(404).json({ success: false, msg: "Channel not found" });

    res.json({
      success: true,
      status: channel.status,
      songsCount: channel.songsCount || 0,
      lastSync: channel.lastSync || null,
    });
  } catch (error) {
    next(error);
  }
};

// ── Background sync ────────────────────────────────────────────
async function _syncInBackground(
  channelDbId: string,
  username: string,
  userId: any,
  db: any,
  forceFullSync: boolean = false
): Promise<void> {
  console.log(`🚀 [bg-sync] Starting for ${username} (id=${channelDbId})`);

  let lastMessageId = 0;
  if (!forceFullSync) {
    const latestSong = await db
      .collection("telegram_songs")
      .find({ channelDbId })
      .sort({ messageId: -1 })
      .limit(1)
      .project({ messageId: 1 })        // ← فقط فیلد لازم
      .toArray();
    if (latestSong.length > 0) {
      lastMessageId = latestSong[0].messageId;
      console.log(`[bg-sync] Incremental from messageId=${lastMessageId}`);
    }
  }

  if (forceFullSync) {
    await db.collection("telegram_songs").deleteMany({ channelDbId });
    console.log(`[bg-sync] Cleared songs for full sync`);
  }

  const result = await telegramService.getChannelAudioFiles(username, userId, lastMessageId);

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
        `[bg-sync] Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(result.files.length / BATCH)}`
      );
    }
  }

  const totalSongs = await db
    .collection("telegram_songs")
    .countDocuments({ channelDbId });

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

  console.log(`✅ [bg-sync] Done for ${username}: ${totalSongs} total (${result.files.length} new)`);

  // thumbnail download با delay — جلوگیری از rate limit
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
      } catch (_) {}
      // ✅ 200ms فاصله بین هر request به Telegram
      await new Promise((r) => setTimeout(r, 200));
    }
  });
}

// ── Reusable helper ────────────────────────────────────────────
export async function addChannelForUser(
  userId: string,
  channelUsername: string,
  channelName: string,
  db: any
): Promise<{ added: boolean; channelDbId?: string; reason?: string }> {
  try {
    const username = channelUsername.replace("@", "");

    const exists = await db.collection("telegram_channels").findOne({
      userId: userId.toString(),
      channelUsername: username,
    });
    if (exists) return { added: false, reason: "already exists" };

    let photoUrl: string | null = null;
    try {
      photoUrl = await telegramService.getChannelPhoto(username, userId);
    } catch (_) {}

    const newChannel = {
      userId: userId.toString(),
      channelUsername: username,
      channelName,
      photoUrl,
      status: "pending",
      songsCount: 0,
      addedAt: new Date(),
      isDefault: true,
    };

    const result = await db.collection("telegram_channels").insertOne(newChannel);
    const channelDbId = result.insertedId.toString();

    _syncInBackground(channelDbId, username, userId, db).catch((err) => {
      console.error(`Background sync failed for ${username}:`, err);
      db.collection("telegram_channels")
        .updateOne({ _id: result.insertedId }, { $set: { status: "error" } })
        .catch(() => {});
    });

    return { added: true, channelDbId };
  } catch (err) {
    console.error("addChannelForUser failed:", err);
    return { added: false, reason: "error" };
  }
}
