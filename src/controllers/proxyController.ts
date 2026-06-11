import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import telegramService from "../services/telegram";

// ── GET /api/proxy ─────────────────────────────────────────────
export const getProxy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;
    const settings = await db.collection("user_proxy_settings").findOne({ userId });

    if (!settings) {
      return res.json({
        success: true,
        data: { proxyType: "none", proxyHost: "", proxyPort: 0, proxyUsername: "", proxyPassword: "", proxySecret: "" },
      });
    }

    res.json({
      success: true,
      data: {
        proxyType: settings.proxyType,
        proxyHost: settings.proxyHost,
        proxyPort: settings.proxyPort,
        proxyUsername: settings.proxyUsername,
        proxyPassword: settings.proxyPassword,
        proxySecret: settings.proxySecret,
      },
    });
  } catch (error) { next(error); }
};

// ── POST /api/proxy ────────────────────────────────────────────
export const setProxy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { proxyType, proxyHost, proxyPort, proxyUsername, proxyPassword, proxySecret } = req.body;

    const db = mongoose.connection.db;
    await db.collection("user_proxy_settings").deleteMany({ userId });

    if (!proxyType || proxyType === "none") {
      return res.json({ success: true, msg: "Proxy disabled" });
    }

    await db.collection("user_proxy_settings").insertOne({
      userId,
      proxyType, proxyHost: proxyHost || "",
      proxyPort: proxyPort || 0,
      proxyUsername: proxyUsername || "",
      proxyPassword: proxyPassword || "",
      proxySecret: proxySecret || "",
      createdAt: new Date(), updatedAt: new Date(),
    });

    res.json({ success: true, msg: "Proxy settings saved" });
  } catch (error) { next(error); }
};

// ── POST /api/proxy/test ───────────────────────────────────────
export const testProxy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const result = await telegramService.testConnection(userId);
    res.json(result);
  } catch (error) { next(error); }
};
