import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import telegramService from "../services/telegram";

const DEFAULT_COVER_URL =
  "https://cdn.qepal.com/qeupload/6759d578be4c8e9471a45c81/download22jpg-ghyhvjsfacjurgu04sjd2zog0rzk1e.jpg";

// ── GET /api/downloads ─────────────────────────────────────────
export const getUserDownloads = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { status, songId } = req.query;
    const db = mongoose.connection.db;

    const matchQuery: any = { userId };
    if (songId) matchQuery.songId = songId;
    else if (status && status !== "all") matchQuery.status = status;

    const pipeline: any[] = [
      { $match: matchQuery },
      { $sort: { startedAt: -1 } },
      {
        $lookup: {
          from: "telegram_songs",
          let: { songIdStr: "$songId" },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$songIdStr" }] } } }],
          as: "songData",
        },
      },
      { $unwind: { path: "$songData", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "audio_cache",
          let: { cacheIdStr: "$cacheId" },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$cacheIdStr" }] } } }],
          as: "cacheData",
        },
      },
      { $unwind: { path: "$cacheData", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          title: { $ifNull: ["$songData.title", "$title"] },
          artist: { $ifNull: ["$songData.artist", "$artist"] },
          thumbnail: { $ifNull: ["$songData.thumbnail", "$thumbnail"] },
          duration: { $ifNull: ["$songData.duration", 0] },
          channelUsername: { $ifNull: ["$songData.channelUsername", ""] },
          messageId: { $ifNull: ["$songData.messageId", 0] },
          expiresAt: { $ifNull: ["$cacheData.expiresAt", null] },
        },
      },
      { $project: { songData: 0, cacheData: 0 } },
    ];

    const downloads = await db.collection("user_downloads").aggregate(pipeline).toArray();

    if (songId) {
      const download = downloads[0];
      if (!download) return res.json({ success: true, downloaded: false, status: null, data: null });
      return res.json({
        success: true,
        downloaded: download.status === "completed",
        status: download.status,
        progress: download.progress || 0,
        data: download,
      });
    }

    res.json({ success: true, data: downloads });
  } catch (error) { next(error); }
};

// ── POST /api/downloads/start ──────────────────────────────────
export const startDownload = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { songId } = req.body;
    if (!songId) return res.status(400).json({ success: false, msg: "songId required" });

    const db = mongoose.connection.db;
    const song = await db.collection("telegram_songs").findOne({ _id: new mongoose.Types.ObjectId(songId) });
    if (!song) return res.status(404).json({ success: false, msg: "Song not found" });

    // چک existing download
    const existing = await db.collection("user_downloads").findOne({
      userId, songId, status: { $in: ["completed", "downloading"] },
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        msg: existing.status === "completed" ? "Already downloaded" : "Download in progress",
      });
    }

    // چک کش
    const cachedFile = await db.collection("audio_cache").findOne({ fileId: song.fileId });
    if (cachedFile) {
      const downloadRecord = {
        userId, songId, fileId: song.fileId,
        status: "completed", progress: 100,
        fileSize: cachedFile.size, downloadedSize: cachedFile.size,
        startedAt: new Date(), completedAt: new Date(),
        cacheId: cachedFile._id.toString(), error: null,
      };
      const result = await db.collection("user_downloads").insertOne(downloadRecord);

      await db.collection("audio_cache").updateOne(
        { _id: cachedFile._id },
        { $set: { expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), permanent: true } }
      );

      return res.json({ success: true, msg: "Downloaded (from cache)", downloadId: result.insertedId });
    }

    // شروع دانلود جدید
    const downloadRecord = {
      userId, songId, fileId: song.fileId,
      status: "downloading", progress: 0,
      fileSize: song.fileSize || 0, downloadedSize: 0,
      startedAt: new Date(), completedAt: null, error: null,
    };
    const result = await db.collection("user_downloads").insertOne(downloadRecord);
    const downloadId = result.insertedId.toString();

    // دانلود در background
    processDownload(downloadId, song, userId, songId, db).catch(console.error);

    res.json({ success: true, msg: "Download started", downloadId });
  } catch (error) { next(error); }
};

// ── DELETE /api/downloads/:id ──────────────────────────────────
export const deleteDownload = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const downloadId = req.params.id;
    const db = mongoose.connection.db;

    const download = await db.collection("user_downloads").findOne({
      _id: new mongoose.Types.ObjectId(downloadId), userId,
    });
    if (!download) return res.status(404).json({ success: false, msg: "Download not found" });

    if (download.cacheId) {
      await db.collection("audio_cache").deleteOne({ _id: new mongoose.Types.ObjectId(download.cacheId) });
    }
    await db.collection("user_downloads").deleteOne({ _id: new mongoose.Types.ObjectId(downloadId) });

    res.json({ success: true, msg: "Download deleted" });
  } catch (error) { next(error); }
};

async function processDownload(downloadId: string, song: any, userId: string, songId: string, db: any) {
  try {
    let thumbnailPromise: Promise<void> | null = null;
    if (!song.thumbnail) {
      thumbnailPromise = telegramService.downloadSongThumbnail(song.channelUsername, song.messageId, userId)
        .then(async (thumbnail) => {
          if (thumbnail) {
            await db.collection("telegram_songs").updateOne(
              { _id: new mongoose.Types.ObjectId(songId) },
              { $set: { thumbnail } }
            );
          }
        }).catch(console.error);
    }

    const result = await telegramService.downloadFile(
      song.fileId, song.channelUsername, song.messageId, userId,
      async (progress, downloaded, total) => {
        await db.collection("user_downloads").updateOne(
          { _id: new mongoose.Types.ObjectId(downloadId) },
          { $set: { progress, downloadedSize: downloaded, fileSize: total } }
        );
      }
    );

    if (!result.success || !result.buffer) throw new Error(result.error || "Download failed");

    if (thumbnailPromise) await thumbnailPromise.catch(console.error);

    const cacheResult = await db.collection("audio_cache").insertOne({
      fileId: song.fileId,
      audioData: result.buffer,
      mimeType: "audio/mpeg",
      size: result.buffer.length,
      fileName: `${song.fileId}.mp3`,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      permanent: true,
    });

    await db.collection("user_downloads").updateOne(
      { _id: new mongoose.Types.ObjectId(downloadId) },
      {
        $set: {
          status: "completed", progress: 100,
          downloadedSize: result.buffer.length,
          completedAt: new Date(),
          cacheId: cacheResult.insertedId.toString(),
        },
      }
    );

    console.log(`✅ Download completed: ${song.title}`);
  } catch (error: any) {
    await db.collection("user_downloads").updateOne(
      { _id: new mongoose.Types.ObjectId(downloadId) },
      { $set: { status: "failed", error: error.message, completedAt: new Date() } }
    );
  }
}
