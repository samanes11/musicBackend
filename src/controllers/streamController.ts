import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import telegramService from "../services/telegram";

const DEFAULT_COVER_URL =
  "https://cdn.qepal.com/qeupload/6759d578be4c8e9471a45c81/download22jpg-ghyhvjsfacjurgu04sjd2zog0rzk1e.jpg";

// ── POST /api/stream ───────────────────────────────────────────
export const streamSong = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { fileId, channelUsername, messageId, songId } = req.body;

    if (!fileId || !channelUsername || !messageId) {
      return res.status(400).json({ success: false, msg: "fileId, channelUsername, messageId required" });
    }

    const db = mongoose.connection.db;

    // 1. چک کردن کش
    const cached = await db.collection("audio_cache").findOne({
      fileId,
      expiresAt: { $gt: new Date() },
    });

    let audioBuffer: Buffer;
    let isFromCache = false;

    if (cached) {
      console.log("✅ Audio from cache");
      audioBuffer = Buffer.from(cached.audioData.buffer || cached.audioData);
      isFromCache = true;

      // دانلود thumbnail در background اگر کاور پیش‌فرض داشت
      if (songId) {
        const song = await db.collection("telegram_songs").findOne({ _id: new mongoose.Types.ObjectId(songId) });
        if (song && (!song.thumbnail || song.thumbnail === DEFAULT_COVER_URL)) {
          downloadThumbnailBg(song, songId, userId, db).catch(console.error);
        }
      }

      // تمدید انقضا
      const minExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const currentExpiry = cached.expiresAt ? new Date(cached.expiresAt).getTime() : Date.now();
      const newExpiry = currentExpiry > minExpiry.getTime() ? new Date(currentExpiry) : minExpiry;
      await db.collection("audio_cache").updateOne(
        { _id: cached._id },
        { $set: { expiresAt: newExpiry, permanent: true } }
      );
    } else {
      console.log("📥 Downloading from Telegram...");

      // دانلود thumbnail موازی
      let songData: any = null;
      if (songId) {
        songData = await db.collection("telegram_songs").findOne({ _id: new mongoose.Types.ObjectId(songId) });
      }

      if (songId && userId) {
        await db.collection("user_downloads").updateOne(
          { userId, songId },
          {
            $set: {
              userId, songId, fileId,
              status: "downloading", progress: 0,
              fileSize: 0, downloadedSize: 0,
              startedAt: new Date(), error: null,
            },
          },
          { upsert: true }
        );
      }

      let thumbnailPromise: Promise<void> | null = null;
      if (songData && (!songData.thumbnail || songData.thumbnail === DEFAULT_COVER_URL)) {
        thumbnailPromise = downloadThumbnailBg(songData, songId, userId, db);
      }

      const result = await telegramService.downloadFile(
        fileId, channelUsername.replace("@", ""), parseInt(messageId), userId,
        async (progress, downloaded, total) => {
          if (songId && userId) {
            await db.collection("user_downloads").updateOne(
              { userId, songId },
              { $set: { progress, downloadedSize: downloaded, fileSize: total } }
            );
          }
        }
      );

      if (!result.success || !result.buffer) {
        if (songId && userId) {
          await db.collection("user_downloads").updateOne(
            { userId, songId },
            { $set: { status: "failed", error: result.error, completedAt: new Date() } }
          );
        }
        return res.status(500).json({ success: false, msg: result.error || "Download failed" });
      }

      audioBuffer = result.buffer;
      if (thumbnailPromise) await thumbnailPromise.catch(console.error);

      // ذخیره در کش
      await db.collection("audio_cache").insertOne({
        fileId,
        audioData: audioBuffer,
        mimeType: "audio/mpeg",
        size: audioBuffer.length,
        fileName: `${fileId}.mp3`,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        permanent: true,
      });
    }

    // ثبت دانلود
    if (songId) {
      await db.collection("user_downloads").updateOne(
        { userId, songId },
        {
          $set: {
            userId, songId, fileId,
            status: "completed", progress: 100,
            fileSize: audioBuffer.length, downloadedSize: audioBuffer.length,
            completedAt: new Date(), error: null,
          },
          $setOnInsert: { startedAt: new Date() },
        },
        { upsert: true }
      );
    }

    // ساخت stream token
    const token = crypto.randomBytes(32).toString("hex");
    const tokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await db.collection("stream_tokens").insertOne({
      token, fileId, channelUsername, messageId: parseInt(messageId),
      userId, createdAt: new Date(), expiresAt: tokenExpiresAt,
    });

    const base64Audio = audioBuffer.toString("base64");

    res.json({
      success: true,
      audioData: base64Audio,
      cached: isFromCache,
      size: audioBuffer.length,
      streamUrl: `/api/stream/${token}`,
      expiresAt: tokenExpiresAt,
    });
  } catch (error) { next(error); }
};

// ── GET /api/stream/:token ─────────────────────────────────────
export const streamByToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const db = mongoose.connection.db;

    const tokenDoc = await db.collection("stream_tokens").findOne({
      token,
      expiresAt: { $gt: new Date() },
    });
    if (!tokenDoc) return res.status(404).json({ success: false, msg: "Token expired or not found" });

    const cached = await db.collection("audio_cache").findOne({ fileId: tokenDoc.fileId });
    if (!cached) return res.status(404).json({ success: false, msg: "Audio not in cache" });

    const audioBuffer = Buffer.from(cached.audioData.buffer || cached.audioData);
    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Length": audioBuffer.length.toString(),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    res.send(audioBuffer);
  } catch (error) { next(error); }
};

async function downloadThumbnailBg(song: any, songId: string | undefined, userId: string, db: any): Promise<void> {
  if (!songId) return;
  try {
    const thumbnail = await telegramService.downloadSongThumbnail(song.channelUsername, song.messageId, userId);
    if (thumbnail) {
      await db.collection("telegram_songs").updateOne(
        { _id: new mongoose.Types.ObjectId(songId) },
        { $set: { thumbnail } }
      );
    }
  } catch (error) {
    try {
      await db.collection("telegram_songs").updateOne(
        { _id: new mongoose.Types.ObjectId(songId) },
        { $set: { thumbnail: DEFAULT_COVER_URL } }
      );
    } catch {}
  }
}
