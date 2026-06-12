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
      query.channelDbId = channelDbId as string;
    } else {
      // آهنگ‌های تمام کانال‌های کاربر
      const userChannels = await db
        .collection("telegram_channels")
        .find({ userId: userId.toString() })
        .toArray();

      console.log(`[getSongs] userId=${userId}, found ${userChannels.length} channels`);

      if (userChannels.length === 0) {
        return res.json({ success: true, data: [], total: 0, page: pageNum, totalPages: 0, hasMore: false });
      }

      const channelIds = userChannels.map((ch) => ch._id.toString());
      console.log(`[getSongs] channelIds:`, channelIds);

      // چک کن چند تا آهنگ با این channelDbId ها داریم
      const totalCheck = await db.collection("telegram_songs").countDocuments({
        channelDbId: { $in: channelIds },
      });
      console.log(`[getSongs] songs matching channelIds: ${totalCheck}`);

      // اگه هیچ آهنگی پیدا نشد، همه آهنگ‌ها رو لاگ کن
      if (totalCheck === 0) {
        const sampleSongs = await db.collection("telegram_songs").find({}).limit(3).toArray();
        console.log(`[getSongs] Sample songs in DB:`, sampleSongs.map(s => ({
          title: s.title,
          channelDbId: s.channelDbId,
          channelDbIdType: typeof s.channelDbId,
        })));
        console.log(`[getSongs] channelIds types:`, channelIds.map(id => ({ id, type: typeof id })));
      }

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
    console.log(`[getSongs] total songs found: ${total}`);

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
  } catch (error) {
    console.error("[getSongs] Error:", error);
    next(error);
  }
};