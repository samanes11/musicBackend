import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import telegramService from "../services/telegram";

const DEFAULT_COVER_URL =
  "https://cdn.qepal.com/qeupload/6759d578be4c8e9471a45c81/download22jpg-ghyhvjsfacjurgu04sjd2zog0rzk1e.jpg";

// ── GET /api/channels ──────────────────────────────────────────
export const getUserChannels = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    const result = await db
      .collection("user_channels")
      .aggregate([
        { $match: { userId } },
        { $sort: { addedAt: -1 } },
        {
          $lookup: {
            from: "channels",
            localField: "channelUsername",
            foreignField: "channelUsername",
            as: "channel",
          },
        },
        {
          $replaceRoot: {
            newRoot: {
              $mergeObjects: [
                { $arrayElemAt: ["$channel", 0] },
                { addedAt: "$addedAt", isDefault: "$isDefault" },
              ],
            },
          },
        },
      ])
      .toArray();

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/channels ─────────────────────────────────────────
export const addChannel = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const { channelUsername, channelName } = req.body;
    if (!channelUsername || !channelName) {
      return res.status(400).json({
        success: false,
        msg: "channelUsername and channelName required",
      });
    }

    const username = channelUsername.replace("@", "");
    const db = mongoose.connection.db;

    // چک کن یوزر قبلاً این چنل رو داره
    const alreadyAdded = await db.collection("user_channels").findOne({
      userId,
      channelUsername: username,
    });
    if (alreadyAdded) {
      return res
        .status(400)
        .json({ success: false, msg: "Channel already added" });
    }

    // چنل shared رو پیدا کن یا بساز
    let channel = await db
      .collection("channels")
      .findOne({ channelUsername: username });
    let needsSync = false;

    if (!channel) {
      const photoUrl = await telegramService.getChannelPhoto(username, userId);
      const result = await db.collection("channels").insertOne({
        channelUsername: username,
        channelName,
        photoUrl,
        songsCount: 0,
        status: "pending",
        lastSync: null,
      });
      channel = {
        _id: result.insertedId,
        channelUsername: username,
        channelName,
        status: "pending",
        songsCount: 0,
      };
      needsSync = true;
    }

    // اضافه کن به user_channels
    await db.collection("user_channels").insertOne({
      userId,
      channelUsername: username,
      addedAt: new Date(),
      isDefault: false,
    });

    res
      .status(201)
      .json({ success: true, msg: "Channel added.", data: channel });

    // فقط اگه چنل جدیده sync کن
    if (needsSync) {
      _syncInBackground(username, userId, db).catch(console.error);
    }
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/channels/:id ───────────────────────────────────
export const removeChannel = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const username = req.params.username;
    const db = mongoose.connection.db;

    const result = await db.collection("user_channels").deleteOne({
      userId,
      channelUsername: username,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, msg: "Channel not found" });
    }

    res.json({ success: true, msg: "Channel removed" });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/channels/:id/sync ────────────────────────────────
export const syncChannel = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const { username } = req.params;
    const db = mongoose.connection.db;

    // چک کن یوزر این چنل رو داره
    const userChannel = await db.collection("user_channels").findOne({
      userId,
      channelUsername: username,
    });
    if (!userChannel) {
      return res.status(404).json({ success: false, msg: "Channel not found" });
    }

    const channel = await db
      .collection("channels")
      .findOne({ channelUsername: username });
    if (channel?.status === "syncing") {
      return res.json({
        success: true,
        syncing: true,
        msg: "Sync already in progress",
      });
    }

    await db
      .collection("channels")
      .updateOne(
        { channelUsername: username },
        { $set: { status: "syncing" } },
      );

    res.json({ success: true, syncing: true, msg: "Sync started." });

    _syncInBackground(username, userId, db).catch((err) => {
      console.error(`Background sync failed for ${username}:`, err);
      db.collection("channels")
        .updateOne({ channelUsername: username }, { $set: { status: "error" } })
        .catch(() => {});
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/channels/:id/sync-status ─────────────────────────
export const getSyncStatus = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const { username } = req.params;
    const db = mongoose.connection.db;

    const userChannel = await db.collection("user_channels").findOne({
      userId,
      channelUsername: username,
    });
    if (!userChannel) {
      return res.status(404).json({ success: false, msg: "Channel not found" });
    }

    const channel = await db.collection("channels").findOne(
      { channelUsername: username },
      {
        projection: {
          status: 1,
          songsCount: 1,
          totalEstimate: 1,
          lastSync: 1,
        },
      },
    );

    res.json({
      success: true,
      status: channel?.status ?? "pending",
      songsCount: channel?.songsCount ?? 0,
      totalEstimate: channel?.totalEstimate ?? 0,
      lastSync: channel?.lastSync ?? null,
    });
  } catch (error) {
    next(error);
  }
};

// ── Background sync ────────────────────────────────────────────
export async function _syncInBackground(
  username: string,
  userId: any,
  db: any,
): Promise<void> {
  const latestSong = await db
    .collection("songs")
    .find({ channelUsername: username })
    .sort({ messageId: -1 })
    .limit(1)
    .project({ messageId: 1 })
    .toArray();

  const lastMessageId = latestSong[0]?.messageId ?? 0;

  // ریست شمارنده‌ها قبل از شروع
  await db
    .collection("channels")
    .updateOne(
      { channelUsername: username },
      { $set: { status: "syncing", totalEstimate: 0 } },
    );

  const result = await telegramService.getChannelAudioFiles(
    username,
    userId,
    lastMessageId,
    async (batch, totalEstimate) => {
      const bulkOps = batch.map((file) => ({
        updateOne: {
          filter: { channelUsername: username, messageId: file.messageId },
          update: {
            $set: {
              channelUsername: username,
              title: file.title,
              artist: file.artist,
              duration: file.duration,
              fileId: file.fileId,
              fileSize: file.fileSize,
              mimeType: file.mimeType,
              messageId: file.messageId,
              messageDate: new Date(file.messageDate * 1000),
              thumbnail: file.thumbnail || DEFAULT_COVER_URL,
            },
          },
          upsert: true,
        },
      }));
      await db.collection("songs").bulkWrite(bulkOps, { ordered: false });

      const syncedCount = await db
        .collection("songs")
        .countDocuments({ channelUsername: username });

      // ← آپدیت فوری بعد هر batch، نه در پایان
      await db.collection("channels").updateOne(
        { channelUsername: username },
        {
          $set: {
            songsCount: syncedCount,
            totalEstimate: totalEstimate || syncedCount,
          },
        },
      );
    },
  );

  if (!result.success || !result.files) {
    await db
      .collection("channels")
      .updateOne({ channelUsername: username }, { $set: { status: "error" } });
    return;
  }

  let photoUrl: string | null = null;
  try {
    photoUrl = await telegramService.getChannelPhoto(username, userId);
  } catch (_) {}

  await db.collection("channels").updateOne(
    { channelUsername: username },
    {
      $set: {
        status: "active",
        lastSync: new Date(),
        ...(photoUrl ? { photoUrl } : {}),
      },
    },
  );

  const thumbLimit = Math.min(result.files.length, 30);
  const CONCURRENCY = 6; // download together

  setImmediate(async () => {
    const filesToProcess = result
      .files!.slice(0, thumbLimit)
      .filter((f) => !f.thumbnail || f.thumbnail === DEFAULT_COVER_URL);

    let idx = 0;

    async function worker() {
      while (idx < filesToProcess.length) {
        const file = filesToProcess[idx++];
        try {
          const thumbnail = await telegramService.downloadSongThumbnail(
            username,
            file.messageId,
            userId,
          );
          if (thumbnail) {
            await db
              .collection("songs")
              .updateOne(
                { channelUsername: username, messageId: file.messageId },
                { $set: { thumbnail } },
              );
          }
        } catch (_) {}
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  });
}

// ── Reusable helper ────────────────────────────────────────────
export async function addChannelForUser(
  userId: string,
  channelUsername: string,
  channelName: string,
  db: any,
): Promise<{ added: boolean; reason?: string }> {
  try {
    const username = channelUsername.replace("@", "");

    const exists = await db.collection("user_channels").findOne({
      userId,
      channelUsername: username,
    });
    if (exists) return { added: false, reason: "already exists" };

    let channel = await db
      .collection("channels")
      .findOne({ channelUsername: username });
    let needsSync = false;

    if (!channel) {
      let photoUrl: string | null = null;
      try {
        photoUrl = await telegramService.getChannelPhoto(username, userId);
      } catch (_) {}

      await db.collection("channels").insertOne({
        channelUsername: username,
        channelName,
        photoUrl,
        songsCount: 0,
        status: "pending",
        lastSync: null,
      });
      needsSync = true;
    }

    await db.collection("user_channels").insertOne({
      userId,
      channelUsername: username,
      addedAt: new Date(),
      isDefault: true,
    });

    if (needsSync) {
      _syncInBackground(username, userId, db).catch(console.error);
    }

    return { added: true };
  } catch (err) {
    console.error("addChannelForUser failed:", err);
    return { added: false, reason: "error" };
  }
}
