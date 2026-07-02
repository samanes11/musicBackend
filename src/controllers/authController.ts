import { Request, Response, NextFunction } from "express";
import User from "../models/User";
import { generateAuthTokens, verifyToken } from "../utils/jwt";
import { applyDefaultChannelsForNewUser } from "./defaultChannelsController";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import mongoose from "mongoose";

// ── POST /api/auth/telegram ─────────────────────────────────────

export const telegramAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { telegramId, telegramUsername, name, authToken } = req.body;

    const botSecret = process.env.BOT_AUTH_SECRET;
    if (!botSecret || authToken !== botSecret + "_" + telegramId) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid auth token" });
    }

    if (!telegramId) {
      return res
        .status(400)
        .json({ success: false, message: "telegramId required" });
    }

    let user = await User.findOne({ telegramId: telegramId.toString() });
    let isNew = false;

    if (!user) {
      // ریجستر جدید
      user = await User.create({
        telegramId: telegramId.toString(),
        telegramUsername: telegramUsername || null,
        name: name || telegramUsername || "User",
        isActive: true,
        profileComplete: false,
        role: "user",
      });
      isNew = true;
    } else {
      // آپدیت اطلاعات تلگرام
      user.telegramUsername = telegramUsername || user.telegramUsername;
      user.lastLogin = new Date();
      if (!user.isActive) {
        return res
          .status(401)
          .json({ success: false, message: "Account inactive" });
      }
    }

    const { accessToken, refreshToken } = generateAuthTokens(user);
    user.refreshToken = refreshToken;
    user.lastLogin = new Date();
    await user.save();

    res.status(isNew ? 201 : 200).json({
      success: true,
      message: isNew ? "Registered successfully" : "Login successful",
      data: {
        user: user.toPublicJSON(),
        accessToken,
        refreshToken,
        isNew,
      },
    });

    if (isNew) {
      applyDefaultChannelsForNewUser(user._id).catch(console.error);
    }
  } catch (error) {
    next(error);
  }
};

// ── GET /api/auth/telegram/poll/:telegramId ─────────────────────
export const pollTelegramAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { sessionId } = req.params;
    const db = (mongoose as any).connection.db;

    const session = await db
      .collection("telegram_auth_sessions")
      .findOne({ sessionId, status: "confirmed" });

    if (!session) {
      return res.json({ success: true, confirmed: false });
    }

    // session رو بعد از خوندن حذف کن
    await db.collection("telegram_auth_sessions").deleteOne({ sessionId });

    // توکن‌ها رو بساز
    const user = await User.findById(session.userId);
    if (!user) {
      return res.json({ success: true, confirmed: false });
    }

    const tokens = generateAuthTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();

    res.json({
      success: true,
      confirmed: true,
      data: {
        user: user.toPublicJSON(),
        ...tokens,
        isNew: session.isNew,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/telegram/session ─────────────────────────────
export const createTelegramSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const sessionId = crypto.randomBytes(16).toString("hex");
    const botUsername = process.env.TELEGRAM_BOT_USERNAME!;
    const db = (mongoose as any).connection.db;

    await db.collection("telegram_auth_sessions").insertOne({
      sessionId,
      status: "pending",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 دقیقه
    });

    const telegramLink = `https://t.me/${botUsername}?start=auth_${sessionId}`;

    res.json({
      success: true,
      data: { sessionId, telegramLink },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/auth/me ────────────────────────────────────────────
export const getMe = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = await User.findById((req as any).user.id);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    user.lastLogin = new Date();
    await user.save();
    try {
      const rawToken = (req.headers.authorization || "").split(" ")[1] || "";
      if (rawToken) {
        const crypto = require("crypto");
        const tokenHash = crypto
          .createHash("sha256")
          .update(rawToken)
          .digest("hex")
          .slice(0, 20);
        const dbConn = (mongoose as any).connection.db;
        dbConn
          .collection("user_sessions")
          .updateOne(
            { userId: user._id.toString(), tokenHash },
            { $set: { lastActive: new Date() } },
          )
          .catch(() => {});
      }
    } catch (_) {}
    res
      .status(200)
      .json({ success: true, data: { user: user.toPublicJSON() } });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/auth/profile ───────────────────────────────────────
export const updateProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { name, email } = req.body;
    const user = await User.findById((req as any).user.id);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    if (name !== undefined && name.trim()) user.name = name.trim();

    await user.save();
    res.status(200).json({
      success: true,
      message: "Profile updated",
      data: { user: user.toPublicJSON() },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/logout ───────────────────────────────────────
export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = await User.findById((req as any).user.id);
    if (user) {
      user.refreshToken = undefined;
      await user.save();
    }
    res.status(200).json({ success: true, message: "Logout successful" });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/refresh ──────────────────────────────────────
export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res
        .status(400)
        .json({ success: false, message: "Refresh token required" });
    const decoded = verifyToken(refreshToken);
    const user = await User.findById(decoded.id).select("+refreshToken");
    if (!user || user.refreshToken !== refreshToken) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid refresh token" });
    }
    const tokens = generateAuthTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();
    res.status(200).json({ success: true, data: tokens });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/session/register
export const registerSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { deviceName, platform, deviceId } = req.body;
    const db = (mongoose as any).connection.db;
    const rawToken = (req.headers.authorization || "").split(" ")[1] || "";
    const crypto = require("crypto");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex")
      .slice(0, 20);

    await db.collection("user_sessions").updateOne(
      { userId, tokenHash },
      {
        $set: {
          userId,
          deviceName: deviceName || "Unknown Device",
          platform: platform || "Unknown",
          deviceId: deviceId || "",
          tokenHash,
          lastActive: new Date(),
          isActive: true,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/sessions
export const getUserSessions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const rawToken = (req.headers.authorization || "").split(" ")[1] || "";
    const crypto = require("crypto");
    const currentTokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex")
      .slice(0, 20);
    const db = (mongoose as any).connection.db;

    const sessions = await db
      .collection("user_sessions")
      .find({ userId, isActive: true })
      .sort({ lastActive: -1 })
      .toArray();

    res.json({
      success: true,
      data: sessions.map((s: any) => ({
        _id: s._id.toString(),
        deviceName: s.deviceName,
        platform: s.platform,
        lastActive: s.lastActive,
        createdAt: s.createdAt,
        isCurrent: s.tokenHash === currentTokenHash,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/auth/sessions/:id
export const deleteUserSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id } = req.params;
    const db = (mongoose as any).connection.db;

    await db
      .collection("user_sessions")
      .updateOne(
        { _id: new mongoose.Types.ObjectId(id), userId },
        { $set: { isActive: false } },
      );
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
