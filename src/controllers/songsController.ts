import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

// ── GET /api/songs ─────────────────────────────────────────────
export const getSongs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { channelDbId, page = 1, limit = 50, search, sortBy } = req.query;

    const db = mongoose.connection.db;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    let query: any = {};

    if (channelDbId) {
      query.channelDbId = channelDbId;
    } else {
      // آهنگ‌های تمام کانال‌های کاربر
      const userChannels = await db
        .collection("telegram_channels")
        .find({ userId: userId.toString() })
        .toArray();

      if (userChannels.length === 0) {
        return res.json({ success: true, data: [], total: 0, page: pageNum, totalPages: 0, hasMore: false });
      }

      const channelIds = userChannels.map((ch) => ch._id.toString());
      query.channelDbId = { $in: channelIds };
    }

    if (search && (search as string).trim()) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { artist: { $regex: search, $options: "i" } },
      ];
    }

    let sortOption: any = { messageDate: -1 };
    if (sortBy === "title") sortOption = { title: 1 };
    else if (sortBy === "artist") sortOption = { artist: 1 };

    const total = await db.collection("telegram_songs").countDocuments(query);
    const songs = await db
      .collection("telegram_songs")
      .find(query)
      .sort(sortOption)
      .skip(skip)
      .limit(limitNum)
      .toArray();

    const totalPages = Math.ceil(total / limitNum);

    res.json({
      success: true,
      data: songs,
      total,
      page: pageNum,
      totalPages,
      hasMore: pageNum < totalPages,
    });
  } catch (error) { next(error); }
};

// ── GET /api/songs/:id ─────────────────────────────────────────
export const getSongById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id } = req.params;
    const db = mongoose.connection.db;

    let song;
    try {
      song = await db.collection("telegram_songs").findOne({ _id: new mongoose.Types.ObjectId(id) });
    } catch {
      return res.status(400).json({ success: false, message: "Invalid song id" });
    }
    if (!song) return res.status(404).json({ success: false, message: "Song not found" });

    const owns = await db.collection("telegram_channels").findOne({
      _id: new mongoose.Types.ObjectId(song.channelDbId),
      userId,
    });
    if (!owns) return res.status(404).json({ success: false, message: "Song not found" });

    res.json({ success: true, data: song });
  } catch (error) { next(error); }
};
