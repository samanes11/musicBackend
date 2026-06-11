import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import telegramService from "../services/telegram";

const DEFAULT_COVER_URL =
  "https://cdn.qepal.com/qeupload/6759d578be4c8e9471a45c81/download22jpg-ghyhvjsfacjurgu04sjd2zog0rzk1e.jpg";

// ── GET /api/channels ──────────────────────────────────────────
export const getUserChannels = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const db = mongoose.connection.db;
    const channels = await db
      .collection("telegram_channels")
      .find({ userId: userId.toString() })
      .sort({ addedAt: -1 })
      .toArray();
    res.json({ success: true, data: channels });
  } catch (error) { next(error); }
};

// ── POST /api/channels ─────────────────────────────────────────
export const addChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { channelUsername, channelName } = req.body;
    if (!channelUsername || !channelName) {
      return res.status(400).json({ success: false, msg: "channelUsername and channelName required" });
    }

    const db = mongoose.connection.db;
    const username = channelUsername.replace("@", "");
    const exists = await db.collection("telegram_channels").findOne({ userId: userId.toString(), channelUsername: username });
    if (exists) return res.status(400).json({ success: false, msg: "Channel already added" });

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
    res.status(201).json({
      success: true,
      msg: "Channel added successfully",
      data: { _id: result.insertedId, ...newChannel },
    });
  } catch (error) { next(error); }
};

// ── DELETE /api/channels/:id ───────────────────────────────────
export const removeChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const channelDbId = req.params.id;
    const db = mongoose.connection.db;

    const channel = await db.collection("telegram_channels").findOne({
      _id: new mongoose.Types.ObjectId(channelDbId),
      userId: userId.toString(),
    });
    if (!channel) return res.status(404).json({ success: false, msg: "Channel not found" });

    await db.collection("telegram_channels").deleteOne({ _id: new mongoose.Types.ObjectId(channelDbId) });
    await db.collection("telegram_songs").deleteMany({ channelDbId });

    res.json({ success: true, msg: `Channel "${channel.channelName}" removed` });
  } catch (error) { next(error); }
};

// ── POST /api/channels/:id/sync ────────────────────────────────
export const syncChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const channelDbId = req.params.id;
    const { channelUsername, forceFullSync } = req.body;

    const db = mongoose.connection.db;

    // پیدا کردن آخرین messageId
    let lastMessageId = 0;
    if (!forceFullSync) {
      const latestSong = await db
        .collection("telegram_songs")
        .find({ channelDbId })
        .sort({ messageId: -1 })
        .limit(1)
        .toArray();
      if (latestSong.length > 0) lastMessageId = latestSong[0].messageId;
    }

    const username = (channelUsername || "").replace("@", "");
    const result = await telegramService.getChannelAudioFiles(username, userId, lastMessageId);

    if (!result.success || !result.files) {
      await db.collection("telegram_channels").updateOne(
        { _id: new mongoose.Types.ObjectId(channelDbId) },
        { $set: { status: "error" } }
      );
      return res.status(500).json({ success: false, msg: result.error || "Sync failed" });
    }

    if (result.files.length === 0) {
      const photoUrl = await telegramService.getChannelPhoto(username, userId);
      await db.collection("telegram_channels").updateOne(
        { _id: new mongoose.Types.ObjectId(channelDbId) },
        { $set: { status: "active", lastSync: new Date(), photoUrl } }
      );
      return res.json({ success: true, msg: "No new songs found", count: 0, newSongs: 0 });
    }

    // اگر full sync بود، آهنگ‌های قدیمی رو پاک کن
    if (forceFullSync) {
      await db.collection("telegram_songs").deleteMany({ channelDbId });
    }

    // Upsert آهنگ‌های جدید
    const bulkOps = result.files.map((file) => ({
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

    if (bulkOps.length > 0) await db.collection("telegram_songs").bulkWrite(bulkOps);

    const totalSongs = await db.collection("telegram_songs").countDocuments({ channelDbId });
    const photoUrl = await telegramService.getChannelPhoto(username, userId);

    await db.collection("telegram_channels").updateOne(
      { _id: new mongoose.Types.ObjectId(channelDbId) },
      { $set: { status: "active", songsCount: totalSongs, lastSync: new Date(), photoUrl } }
    );

    // دانلود thumbnail در background
    setImmediate(async () => {
      const limit = Math.min(result.files!.length, 50);
      for (let i = 0; i < limit; i++) {
        const file = result.files![i];
        if (file.thumbnail && file.thumbnail !== DEFAULT_COVER_URL) continue;
        try {
          const thumbnail = await telegramService.downloadSongThumbnail(username, file.messageId, userId);
          if (thumbnail && thumbnail !== DEFAULT_COVER_URL) {
            await db.collection("telegram_songs").updateOne(
              { channelDbId, messageId: file.messageId },
              { $set: { thumbnail } }
            );
          }
        } catch (err) {
          console.error(`Thumbnail failed for ${file.title}:`, err);
        }
      }
    });

    res.json({
      success: true,
      msg: forceFullSync ? `Full sync: ${totalSongs} songs` : `${result.files.length} new songs added`,
      count: totalSongs,
      newSongs: result.files.length,
    });
  } catch (error) { next(error); }
};
