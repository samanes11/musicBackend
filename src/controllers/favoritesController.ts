import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

// ── GET /api/favorites ─────────────────────────────────────────
export const getFavorites = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    const favorites = await db
      .collection("user_favorites")
      .find({ userId })
      .sort({ addedAt: -1 })
      .toArray();

    const songIds = favorites
      .map((f) => { try { return new mongoose.Types.ObjectId(f.songId); } catch { return null; } })
      .filter(Boolean);

    const songs = await db.collection("telegram_songs").find({ _id: { $in: songIds } }).toArray();

    const idOrder = favorites.map((f) => f.songId.toString());
    const sorted = idOrder
      .map((id) => songs.find((s) => s._id.toString() === id))
      .filter(Boolean);

    res.json({ success: true, data: sorted });
  } catch (error) { next(error); }
};

// ── POST /api/favorites/toggle ─────────────────────────────────
export const toggleFavorite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { songId } = req.body;
    if (!songId) return res.status(400).json({ success: false, msg: "songId required" });

    const db = mongoose.connection.db;
    const existing = await db.collection("user_favorites").findOne({ userId, songId });

    if (existing) {
      await db.collection("user_favorites").deleteOne({ _id: existing._id });
      return res.json({ success: true, liked: false });
    } else {
      await db.collection("user_favorites").insertOne({ userId, songId, addedAt: new Date() });
      return res.json({ success: true, liked: true });
    }
  } catch (error) { next(error); }
};
