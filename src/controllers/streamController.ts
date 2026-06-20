import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import telegramService from "../services/telegram";
import mongoose from "mongoose";

const DEFAULT_COVER_URL =
  "https://cdn.qepal.com/qeupload/6759d578be4c8e9471a45c81/download22jpg-ghyhvjsfacjurgu04sjd2zog0rzk1e.jpg";

// ── Disk cache ─────────────────────────────────────────────────
const AUDIO_CACHE_DIR =
  process.env.AUDIO_CACHE_DIR || path.join(process.cwd(), "audio_cache");

if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
  console.log(`📁 Audio cache directory created: ${AUDIO_CACHE_DIR}`);
}

function getCachePath(fileId: string): string {
  const safe = fileId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(AUDIO_CACHE_DIR, `${safe}.mp3`);
}

function isCached(fileId: string): boolean {
  try {
    return fs.statSync(getCachePath(fileId)).size > 0;
  } catch {
    return false;
  }
}

// ── JWT stream token (بدون DB) ─────────────────────────────────
const STREAM_SECRET = process.env.STREAM_TOKEN_SECRET || process.env.JWT_SECRET!;

interface StreamTokenPayload {
  fileId:          string;
  channelUsername: string;
  messageId:       number;
  userId:          string;
}

function signStreamToken(payload: StreamTokenPayload): string {
  return jwt.sign(payload, STREAM_SECRET, { expiresIn: "1h" });
}

function verifyStreamToken(token: string): StreamTokenPayload | null {
  try {
    return jwt.verify(token, STREAM_SECRET) as StreamTokenPayload;
  } catch {
    return null;
  }
}

// ── POST /api/stream ───────────────────────────────────────────
export const streamSong = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
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
    let audioBuffer: Buffer;
    let isFromCache = false;

    // ── 1. disk cache ──────────────────────────────────────────
    if (isCached(fileId)) {
      console.log(`✅ [stream] Serving from disk cache: ${fileId}`);
      audioBuffer = fs.readFileSync(getCachePath(fileId));
      isFromCache = true;
    } else {
      // ── 2. download from Telegram ────────────────────────────
      console.log(`📥 [stream] Downloading from Telegram: ${fileId}`);

      // thumbnail در background (non-blocking)
      if (songId) {
        _downloadThumbnailBg(songId, userId, db).catch(console.error);
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

      // ── 3. persist to disk ───────────────────────────────────
      try {
        fs.writeFileSync(getCachePath(fileId), audioBuffer);
        console.log(`💾 [stream] Cached: ${fileId} (${_fmtBytes(audioBuffer.length)})`);
      } catch (err) {
        console.error(`⚠️  Could not write to disk cache:`, err);
      }
    }

    // ── 4. JWT stream token (بدون DB) ─────────────────────────
    const token = signStreamToken({
      fileId,
      channelUsername,
      messageId: parseInt(messageId),
      userId,
    });

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // ── 5. stream to client ────────────────────────────────────
    res.set({
      "Content-Type":   "audio/mpeg",
      "Content-Length": audioBuffer.length.toString(),
      "Accept-Ranges":  "bytes",
      "Cache-Control":  "no-store",
      "X-Cached":       isFromCache ? "true" : "false",
      "X-File-Size":    audioBuffer.length.toString(),
      "X-Stream-Token": token,
      "X-Stream-Url":   `/api/stream/${token}`,
      "X-Expires-At":   expiresAt.toISOString(),
    });

    res.send(audioBuffer);
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/:token ─────────────────────────────────────
export const streamByToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { token } = req.params;

    // verify JWT — بدون DB lookup
    const payload = verifyStreamToken(token);
    if (!payload) {
      return res.status(404).json({ success: false, msg: "Token expired or invalid" });
    }

    if (!isCached(payload.fileId)) {
      return res.status(404).json({ success: false, msg: "Audio not in disk cache" });
    }

    const cachePath = getCachePath(payload.fileId);
    const fileSize  = fs.statSync(cachePath).size;
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start     = parseInt(parts[0], 10);
      const end       = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.set({
        "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges":  "bytes",
        "Content-Length": chunkSize.toString(),
        "Content-Type":   "audio/mpeg",
        "Cache-Control":  "no-store",
      });
      res.status(206);
      fs.createReadStream(cachePath, { start, end }).pipe(res);
    } else {
      res.set({
        "Content-Type":   "audio/mpeg",
        "Content-Length": fileSize.toString(),
        "Accept-Ranges":  "bytes",
        "Cache-Control":  "no-store",
      });
      fs.createReadStream(cachePath).pipe(res);
    }
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/check/:fileId ──────────────────────────────
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
      try { size = fs.statSync(getCachePath(fileId)).size; } catch {}
    }
    res.json({ success: true, cached, size });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/token/:songId ──────────────────────────────
export const issueStreamToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId  = (req as any).user.id.toString();
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
        msg: "Audio not cached — use POST /api/stream first",
      });
    }

    const token     = signStreamToken({
      fileId:          song.fileId,
      channelUsername: song.channelUsername,
      messageId:       song.messageId,
      userId,
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    res.json({ success: true, streamUrl: `/api/stream/${token}`, expiresAt });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/admin/stats ────────────────────────────────
export const getCacheStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    let totalSize = 0;
    let fileCount = 0;

    try {
      for (const f of fs.readdirSync(AUDIO_CACHE_DIR)) {
        if (!f.endsWith(".mp3")) continue;
        try {
          totalSize += fs.statSync(path.join(AUDIO_CACHE_DIR, f)).size;
          fileCount++;
        } catch {}
      }
    } catch {}

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
  songId: string,
  userId: string,
  db: any
): Promise<void> {
  try {
    const song = await db
      .collection("telegram_songs")
      .findOne({ _id: new mongoose.Types.ObjectId(songId) });

    if (!song || (song.thumbnail && song.thumbnail !== DEFAULT_COVER_URL)) return;

    const thumbnail = await telegramService.downloadSongThumbnail(
      song.channelUsername,
      song.messageId,
      userId
    );

    await db.collection("telegram_songs").updateOne(
      { _id: new mongoose.Types.ObjectId(songId) },
      { $set: { thumbnail: thumbnail || DEFAULT_COVER_URL } }
    );
  } catch {}
}

function _fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
