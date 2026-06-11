import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

// ── GET /api/playlists ─────────────────────────────────────────
export const getPlaylists = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;
    const playlists = await db
      .collection("user_playlists")
      .find({ userId })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json({ success: true, data: playlists });
  } catch (error) { next(error); }
};

// ── POST /api/playlists ────────────────────────────────────────
export const createPlaylist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ success: false, msg: "name required" });

    const db = mongoose.connection.db;
    const existing = await db.collection("user_playlists").findOne({ userId, name });
    if (existing) return res.status(400).json({ success: false, msg: "Playlist name already exists" });

    const newPlaylist = {
      userId, name,
      description: description || null,
      coverImage: null,
      songIds: [],
      songsCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("user_playlists").insertOne(newPlaylist);
    res.status(201).json({ success: true, msg: "Playlist created", data: { _id: result.insertedId, ...newPlaylist } });
  } catch (error) { next(error); }
};

// ── DELETE /api/playlists/:id ──────────────────────────────────
export const deletePlaylist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const playlistId = req.params.id;
    const db = mongoose.connection.db;

    const playlist = await db.collection("user_playlists").findOne({
      _id: new mongoose.Types.ObjectId(playlistId), userId,
    });
    if (!playlist) return res.status(404).json({ success: false, msg: "Playlist not found" });

    await db.collection("user_playlists").deleteOne({ _id: new mongoose.Types.ObjectId(playlistId) });
    res.json({ success: true, msg: "Playlist deleted" });
  } catch (error) { next(error); }
};

// ── GET /api/playlists/:id/songs ───────────────────────────────
export const getPlaylistSongs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const playlistId = req.params.id;
    const { page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const db = mongoose.connection.db;
    const playlist = await db.collection("user_playlists").findOne({
      _id: new mongoose.Types.ObjectId(playlistId), userId,
    });
    if (!playlist) return res.status(404).json({ success: false, msg: "Playlist not found" });

    const songIds = playlist.songIds || [];
    const skip = (pageNum - 1) * limitNum;
    const pageSongIds = songIds.slice(skip, skip + limitNum).map((id: string) => {
      try { return new mongoose.Types.ObjectId(id); } catch { return null; }
    }).filter(Boolean);

    const songs = await db.collection("telegram_songs").find({ _id: { $in: pageSongIds } }).toArray();
    const sorted = pageSongIds.map((id: any) => songs.find((s) => s._id.toString() === id.toString())).filter(Boolean);

    res.json({
      success: true,
      data: sorted,
      playlist: { _id: playlist._id, name: playlist.name, songsCount: playlist.songsCount || 0 },
      total: songIds.length,
      page: pageNum,
      totalPages: Math.ceil(songIds.length / limitNum),
      hasMore: pageNum < Math.ceil(songIds.length / limitNum),
    });
  } catch (error) { next(error); }
};

// ── POST /api/playlists/:id/songs ──────────────────────────────
export const addSongToPlaylist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const playlistId = req.params.id;
    const { songId } = req.body;
    if (!songId) return res.status(400).json({ success: false, msg: "songId required" });

    const db = mongoose.connection.db;
    const playlist = await db.collection("user_playlists").findOne({
      _id: new mongoose.Types.ObjectId(playlistId), userId,
    });
    if (!playlist) return res.status(404).json({ success: false, msg: "Playlist not found" });
    if (playlist.songIds?.includes(songId)) {
      return res.status(400).json({ success: false, msg: "Song already in playlist" });
    }

    await db.collection("user_playlists").updateOne(
      { _id: new mongoose.Types.ObjectId(playlistId) },
      { $push: { songIds: songId } as any, $inc: { songsCount: 1 }, $set: { updatedAt: new Date() } }
    );
    res.json({ success: true, msg: "Song added to playlist" });
  } catch (error) { next(error); }
};

// ── DELETE /api/playlists/:id/songs/:songId ────────────────────
export const removeSongFromPlaylist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id: playlistId, songId } = req.params;

    const db = mongoose.connection.db;
    const playlist = await db.collection("user_playlists").findOne({
      _id: new mongoose.Types.ObjectId(playlistId), userId,
    });
    if (!playlist) return res.status(404).json({ success: false, msg: "Playlist not found" });

    await db.collection("user_playlists").updateOne(
      { _id: new mongoose.Types.ObjectId(playlistId) },
      { $pull: { songIds: songId } as any, $inc: { songsCount: -1 }, $set: { updatedAt: new Date() } }
    );
    res.json({ success: true, msg: "Song removed from playlist" });
  } catch (error) { next(error); }
};
