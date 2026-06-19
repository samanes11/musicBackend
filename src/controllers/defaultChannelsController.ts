import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import User from "../models/User";
import { addChannelForUser } from "./channelsController";

// ── GET /api/admin/default-channels ────────────────────────────
export const getDefaultChannels = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = mongoose.connection.db;
    const list = await db
      .collection("default_channels")
      .find()
      .sort({ addedAt: -1 })
      .toArray();
    res.json({ success: true, data: list });
  } catch (error) { next(error); }
};

// ── POST /api/admin/default-channels ───────────────────────────
export const addDefaultChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channelUsername, channelName } = req.body;
    if (!channelUsername || !channelName) {
      return res.status(400).json({ success: false, msg: "channelUsername and channelName required" });
    }

    const db = mongoose.connection.db;
    const username = channelUsername.replace("@", "");

    const exists = await db.collection("default_channels").findOne({ channelUsername: username });
    if (exists) {
      return res.status(400).json({ success: false, msg: "This channel is already a default channel" });
    }

    const doc = {
      channelUsername: username,
      channelName,
      addedAt: new Date(),
    };
    const result = await db.collection("default_channels").insertOne(doc);

    res.status(201).json({
      success: true,
      msg: "Default channel added",
      data: { _id: result.insertedId, ...doc },
    });
  } catch (error) { next(error); }
};

// ── DELETE /api/admin/default-channels/:id ─────────────────────
// نکته: این فقط از لیست پیش‌فرض‌ها حذفش می‌کنه؛ چنلی که قبلاً برای
// کاربرها sync شده، دستی پاک نمیشه (که درسته — نباید زیر پای کاربر خالی شه)
export const removeDefaultChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = mongoose.connection.db;
    const result = await db
      .collection("default_channels")
      .deleteOne({ _id: new mongoose.Types.ObjectId(req.params.id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, msg: "Default channel not found" });
    }
    res.json({ success: true, msg: "Default channel removed" });
  } catch (error) { next(error); }
};

// ── POST /api/admin/default-channels/apply-all ─────────────────
// چنل‌های پیش‌فرض رو به همه‌ی کاربرهای *موجود* که هنوز ندارنش اضافه می‌کنه.
export const applyDefaultChannelsToAllUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = mongoose.connection.db;
    const defaults = await db.collection("default_channels").find().toArray();
    if (defaults.length === 0) {
      return res.json({ success: true, msg: "No default channels configured", added: 0, usersProcessed: 0 });
    }

    const users = await User.find({ isActive: true }).select("_id");

    let added = 0;
    for (const user of users) {
      const userId = user._id.toString();
      const existingChannels = await db
        .collection("telegram_channels")
        .find({ userId })
        .toArray();
      const existingUsernames = new Set(existingChannels.map((c: any) => c.channelUsername));

      for (const dc of defaults) {
        if (existingUsernames.has(dc.channelUsername)) continue;
        const result = await addChannelForUser(userId, dc.channelUsername, dc.channelName, db);
        if (result.added) added++;
      }
    }

    res.json({ success: true, msg: "Applied default channels", added, usersProcessed: users.length });
  } catch (error) { next(error); }
};

// ── Internal helper: called right after a new user registers ──
export async function applyDefaultChannelsForNewUser(userId: any): Promise<void> {
  try {
    const db = mongoose.connection.db;
    const defaults = await db.collection("default_channels").find().toArray();
    for (const dc of defaults) {
      await addChannelForUser(userId.toString(), dc.channelUsername, dc.channelName, db);
    }
  } catch (err) {
    console.error("applyDefaultChannelsForNewUser failed:", err);
  }
}