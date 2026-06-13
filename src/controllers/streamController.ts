import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import telegramService from "../services/telegram";

const DEFAULT_COVER_URL =
  "https://cdn.qepal.com/qeupload/6759d578be4c8e9471a45c81/download22jpg-ghyhvjsfacjurgu04sjd2zog0rzk1e.jpg";

// ── Local disk cache ───────────────────────────────────────────
// Audio files are cached on the server filesystem, NOT in MongoDB.
// MongoDB audio_cache collection is no longer used for audio blobs.
// Path: AUDIO_CACHE_DIR/<fileId>.mp3
// ──────────────────────────────────────────────────────────────

const AUDIO_CACHE_DIR = process.env.AUDIO_CACHE_DIR || path.join(process.cwd(), "audio_cache");

// Ensure cache directory exists on startup
if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
  console.log(`📁 Audio cache directory created: ${AUDIO_CACHE_DIR}`);
}

function getCachePath(fileId: string): string {
  // Sanitise fileId — only allow alphanumeric + dash/underscore
  const safe = fileId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(AUDIO_CACHE_DIR, `${safe}.mp3`);
}

function isCached(fileId: string): boolean {
  const p = getCachePath(fileId);
  try {
    const stat = fs.statSync(p);
    return stat.size > 0;
  } catch {
    return false;
  }
}

// ── POST /api/stream ───────────────────────────────────────────
// Downloads audio from Telegram (or serves from local disk cache),
// then streams it back to the Flutter client as chunked HTTP.
// The client (Flutter) is responsible for persisting the file locally.
// ──────────────────────────────────────────────────────────────
export const streamSong = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { fileId, channelUsername, messageId, songId } = req.body;

    if (!fileId || !channelUsername || !messageId) {
      return res.status(400).json({
        success: false,
        msg: "fileId, channelUsername, messageId required",
      });
    }

    const db = mongoose.connection.db;
    const cachePath = getCachePath(fileId);
    let audioBuffer: Buffer;
    let isFromCache = false;

    // ── 1. Check disk cache ────────────────────────────────────
    if (isCached(fileId)) {
      console.log(`✅ [stream] Serving from disk cache: ${fileId}`);
      audioBuffer = fs.readFileSync(cachePath);
      isFromCache = true;
    } else {
      // ── 2. Download from Telegram ────────────────────────────
      console.log(`📥 [stream] Downloading from Telegram: ${fileId}`);

      // Fire thumbnail download in background (non-blocking)
      let songData: any = null;
      if (songId) {
        try {
          songData = await db
            .collection("telegram_songs")
            .findOne({ _id: new mongoose.Types.ObjectId(songId) });
        } catch (_) {}
      }

      if (
        songId &&
        songData &&
        (!songData.thumbnail || songData.thumbnail === DEFAULT_COVER_URL)
      ) {
        _downloadThumbnailBg(songData, songId, userId, db).catch(console.error);
      }

      const result = await telegramService.downloadFile(
        fileId,
        channelUsername.replace("@", ""),
        parseInt(messageId),
        userId
      );

      if (!result.success || !result.buffer) {
        return res.status(502).json({
          success: false,
          msg: result.error || "Telegram download failed",
        });
      }

      audioBuffer = result.buffer;

      // ── 3. Persist to disk cache ─────────────────────────────
      try {
        fs.writeFileSync(cachePath, audioBuffer);
        console.log(
          `💾 [stream] Cached to disk: ${fileId} (${_fmtBytes(audioBuffer.length)})`
        );
      } catch (err) {
        // Non-fatal: serve the audio even if we can't cache it
        console.error(`⚠️  [stream] Could not write to disk cache:`, err);
      }
    }

    // ── 4. Update song download record (lightweight, no blob) ──
    if (songId) {
      db.collection("user_downloads")
        .updateOne(
          { userId, songId },
          {
            $set: {
              userId,
              songId,
              fileId,
              status: "completed",
              progress: 100,
              fileSize: audioBuffer.length,
              completedAt: new Date(),
              error: null,
              // No cacheId — we no longer store blobs in Mongo
              diskCached: true,
            },
            $setOnInsert: { startedAt: new Date() },
          },
          { upsert: true }
        )
        .catch(console.error);
    }

    // ── 5. Issue a short-lived stream token (for GET endpoint) ─
    const token = crypto.randomBytes(32).toString("hex");
    const tokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    db.collection("stream_tokens")
      .insertOne({
        token,
        fileId,
        channelUsername,
        messageId: parseInt(messageId),
        userId,
        createdAt: new Date(),
        expiresAt: tokenExpiresAt,
      })
      .catch(console.error);

    // ── 6. Stream to client ────────────────────────────────────
    // We send the raw audio bytes. The Flutter client should save
    // this to local storage to avoid re-downloading next time.
    const contentLength = audioBuffer.length;

    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Length": contentLength.toString(),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Cached": isFromCache ? "true" : "false",
      "X-File-Size": contentLength.toString(),
      "X-Stream-Token": token,
      "X-Stream-Url": `/api/stream/${token}`,
      "X-Expires-At": tokenExpiresAt.toISOString(),
    });

    res.send(audioBuffer);
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/:token ─────────────────────────────────────
// Token-based streaming — client can use this URL directly with
// just_audio's setUrl() for seekable playback.
// ──────────────────────────────────────────────────────────────
export const streamByToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { token } = req.params;
    const db = mongoose.connection.db;

    const tokenDoc = await db.collection("stream_tokens").findOne({
      token,
      expiresAt: { $gt: new Date() },
    });

    if (!tokenDoc) {
      return res
        .status(404)
        .json({ success: false, msg: "Token expired or not found" });
    }

    const cachePath = getCachePath(tokenDoc.fileId);

    if (!isCached(tokenDoc.fileId)) {
      return res
        .status(404)
        .json({ success: false, msg: "Audio not in disk cache" });
    }

    const stat = fs.statSync(cachePath);
    const fileSize = stat.size;
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      // ── Range request (seekable playback) ───────────────────
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.set({
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize.toString(),
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      });
      res.status(206);

      const stream = fs.createReadStream(cachePath, { start, end });
      stream.pipe(res);
    } else {
      // ── Full file ────────────────────────────────────────────
      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Length": fileSize.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });

      const stream = fs.createReadStream(cachePath);
      stream.pipe(res);
    }
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/check/:fileId ──────────────────────────────
// Lightweight check: is this file on disk cache?
// Flutter calls this before deciding to download.
// ──────────────────────────────────────────────────────────────
export const checkDiskCache = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { fileId } = req.params;
    const cached = isCached(fileId);
    let size = 0;
    if (cached) {
      try {
        size = fs.statSync(getCachePath(fileId)).size;
      } catch (_) {}
    }
    res.json({ success: true, cached, size });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/token-url/:songId ─────────────────────────
// Issue a fresh stream token for a song that's already disk-cached.
// Flutter uses the returned URL directly with just_audio setUrl().
// ──────────────────────────────────────────────────────────────
export const issueStreamToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { songId } = req.params;
    const db = mongoose.connection.db;

    const song = await db
      .collection("telegram_songs")
      .findOne({ _id: new mongoose.Types.ObjectId(songId) });

    if (!song) {
      return res.status(404).json({ success: false, msg: "Song not found" });
    }

    if (!isCached(song.fileId)) {
      return res.status(404).json({
        success: false,
        msg: "Audio not cached on server — use POST /api/stream to download first",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await db.collection("stream_tokens").insertOne({
      token,
      fileId: song.fileId,
      channelUsername: song.channelUsername,
      messageId: song.messageId,
      userId,
      createdAt: new Date(),
      expiresAt,
    });

    res.json({
      success: true,
      streamUrl: `/api/stream/${token}`,
      expiresAt,
    });
  } catch (error) {
    next(error);
  }
};

// ── Admin: cache stats ─────────────────────────────────────────
export const getCacheStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    let totalSize = 0;
    let fileCount = 0;

    try {
      const files = fs.readdirSync(AUDIO_CACHE_DIR);
      for (const f of files) {
        if (!f.endsWith(".mp3")) continue;
        try {
          totalSize += fs.statSync(path.join(AUDIO_CACHE_DIR, f)).size;
          fileCount++;
        } catch (_) {}
      }
    } catch (_) {}

    res.json({
      success: true,
      data: {
        fileCount,
        totalSize,
        totalSizeFormatted: _fmtBytes(totalSize),
        cacheDir: AUDIO_CACHE_DIR,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── Helpers ────────────────────────────────────────────────────

async function _downloadThumbnailBg(
  song: any,
  songId: string,
  userId: string,
  db: any
): Promise<void> {
  try {
    const thumbnail = await telegramService.downloadSongThumbnail(
      song.channelUsername,
      song.messageId,
      userId
    );
    if (thumbnail) {
      await db
        .collection("telegram_songs")
        .updateOne(
          { _id: new mongoose.Types.ObjectId(songId) },
          { $set: { thumbnail } }
        );
    }
  } catch {
    try {
      await db
        .collection("telegram_songs")
        .updateOne(
          { _id: new mongoose.Types.ObjectId(songId) },
          { $set: { thumbnail: DEFAULT_COVER_URL } }
        );
    } catch (_) {}
  }
}

function _fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}