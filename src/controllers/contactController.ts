// src/controllers/contactController.ts
import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

// ── POST /api/contact ──────────────────────────────────────────
// کاربر یک پیام برای دولوپر ارسال می‌کند
export const sendMessage = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { name, email, message } = req.body;

    if (!message || !message.toString().trim()) {
      return res.status(400).json({ success: false, msg: "Message is required" });
    }

    const db = mongoose.connection.db;

    await db.collection("contact_messages").insertOne({
      userId,
      name: (name || "").toString().trim(),
      email: (email || "").toString().trim(),
      message: message.toString().trim(),
      createdAt: new Date(),
      read: false,
    });

    res.status(201).json({ success: true, msg: "Message sent" });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/admin/messages ────────────────────────────────────
// لیست همه پیام‌های ارسال‌شده برای ادمین
export const getMessages = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const db = mongoose.connection.db;

    const messages = await db
      .collection("contact_messages")
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: messages, total: messages.length });
  } catch (error) {
    next(error);
  }
};