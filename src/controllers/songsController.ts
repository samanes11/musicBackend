import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── GET /api/songs ─────────────────────────────────────────────
export const getSongs = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id;
    const { channelDbId, page = 1, limit = 50, search, sortBy } = req.query;
    const db = mongoose.connection.db;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(200, parseInt(limit as string));
    const skip = (pageNum - 1) * limitNum;

    const query: Record<string, any> = {};

    if (channelDbId) {
      query.channelDbId = channelDbId;
    } else {
      const userChannels = await db
        .collection("telegram_channels")
        .find({ userId: userId.toString() }, { projection: { _id: 1 } })
        .toArray();

      if (userChannels.length === 0) {
        return res.json({
          success: true,
          data: [],
          total: 0,
          page: pageNum,
          totalPages: 0,
          hasMore: false,
        });
      }

      query.channelDbId = { $in: userChannels.map((ch) => ch._id.toString()) };
    }

    let sort: Record<string, any> = { messageDate: -1 };
    if (sortBy === "title") sort = { title: 1 };
    else if (sortBy === "artist") sort = { artist: 1 };

    if (search && (search as string).trim()) {
      const safe = escapeRegex((search as string).trim());
      query.$or = [
        { title: { $regex: safe, $options: "i" } },
        { artist: { $regex: safe, $options: "i" } },
      ];
    }

    const [total, songs] = await Promise.all([
      db.collection("telegram_songs").countDocuments(query),
      db
        .collection("telegram_songs")
        .find(query)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .toArray(),
    ]);

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
    next(error);
  }
};

// ── GET /api/songs/:id ─────────────────────────────────────────
export const getSongById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id } = req.params;
    const db = mongoose.connection.db;

    let objId: mongoose.Types.ObjectId;
    try {
      objId = new mongoose.Types.ObjectId(id);
    } catch {
      return res
        .status(400)
        .json({ success: false, message: "Invalid song id" });
    }

    const song = await db.collection("telegram_songs").findOne({ _id: objId });
    if (!song)
      return res
        .status(404)
        .json({ success: false, message: "Song not found" });

    // verify ownership: the channel that owns the song must belong to this user
    const owns = await db.collection("telegram_channels").findOne(
      {
        _id: new mongoose.Types.ObjectId(song.channelDbId),
        userId,
      },
      { projection: { _id: 1 } }, // ← only need to know it exists
    );
    if (!owns)
      return res
        .status(404)
        .json({ success: false, message: "Song not found" });

    res.json({ success: true, data: song });
  } catch (error) {
    next(error);
  }
};
