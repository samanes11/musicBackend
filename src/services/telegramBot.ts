import TelegramBot from "node-telegram-bot-api";
import type { Message } from "node-telegram-bot-api";
import mongoose from "mongoose";
import crypto from "crypto";
import axios from "axios";

const BOT_AUTH_SECRET = process.env.BOT_AUTH_SECRET!;
const API_BASE = process.env.PUBLIC_API_URL!;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const pendingConnections = new Map<
  string,
  { userId: string; expiresAt: Date }
>();

export function generateConnectionCode(userId: string): string {
  for (const [code, data] of pendingConnections.entries()) {
    if (data.userId === userId) pendingConnections.delete(code);
  }
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  pendingConnections.set(code, {
    userId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return code;
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  const telegramUsername = msg.from.username || "";
  const name = [msg.from.first_name, msg.from.last_name]
    .filter(Boolean)
    .join(" ");

  const db = mongoose.connection.db;

  // Check if user came via deep link (e.g. /start auth)
  const payload = msg.text?.split(" ")[1];

  if (payload === "auth" || !payload) {
    try {
      const authToken = `${BOT_AUTH_SECRET}_${telegramId}`;

      const res = await axios.post(`${API_BASE}/auth/telegram`, {
        telegramId,
        telegramUsername,
        name,
        authToken,
      });

      const { isNew, user } = res.data.data;

      // Save auth session for Flutter polling
      await db.collection("telegram_auth_sessions").updateOne(
        { telegramId },
        {
          $set: {
            telegramId,
            status: "confirmed",
            userId: user.id,
            isNew,
            confirmedAt: new Date(),
            expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
          },
        },
        { upsert: true },
      );

      if (isNew) {
        await bot.sendMessage(
          chatId,
          `🎵 *Welcome to Tel Player!*\n\n` +
            `Your account has been successfully created.\n` +
            `You can now return to the app and continue.`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot.sendMessage(
          chatId,
          `✅ *Authentication Successful*\n\n` +
            `Welcome back to Tel Player.\n` +
            `Please return to the app to continue.`,
          { parse_mode: "Markdown" },
        );
      }
    } catch (err) {
      console.error("Telegram auth failed:", err.message);

      await bot.sendMessage(
        chatId,
        `❌ *Authentication Failed*\n\n` +
          `We were unable to complete your authentication.\n` +
          `Please try again in a few moments.`,
        { parse_mode: "Markdown" },
      );
    }

    return;
  }
});

bot.onText(/\/start (.+)/, async (msg, match) => {
  const payload = match?.[1];

  if (!payload) return;

  if (payload.startsWith("auth_")) {
    const sessionId = payload.replace("auth_", "");
    const telegramId = msg.from.id.toString();
    const telegramUsername = msg.from.username || "";
    const name = [msg.from.first_name, msg.from.last_name]
      .filter(Boolean)
      .join(" ");

    const db = mongoose.connection.db;

    try {
      const authToken = `${BOT_AUTH_SECRET}_${telegramId}`;

      const res = await axios.post(`${API_BASE}/auth/telegram`, {
        telegramId,
        telegramUsername,
        name,
        authToken,
      });

      const { isNew, user } = res.data.data;

      // Update auth session
      await db.collection("telegram_auth_sessions").updateOne(
        { sessionId },
        {
          $set: {
            status: "confirmed",
            telegramId,
            userId: user.id,
            isNew,
            confirmedAt: new Date(),
          },
        },
      );

      await bot.sendMessage(
        msg.chat.id,
        isNew
          ? `🎵 *Welcome to Tel Player!*\n\n` +
              `Your account has been successfully created.\n` +
              `Please return to the app to continue.`
          : `✅ *Authentication Successful*\n\n` +
              `Welcome back to Tel Player.\n` +
              `Please return to the app to continue.`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      console.error("Telegram auth failed:", err.message);

      await bot.sendMessage(
        msg.chat.id,
        `❌ *Authentication Failed*\n\n` +
          `We were unable to complete your authentication.\n` +
          `Please try again in a few moments.`,
        { parse_mode: "Markdown" },
      );
    }
  }
});

bot.onText(/^[A-F0-9]{6}$/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const telegramUsername = msg.from!.username || "";
  const code = msg.text!.trim().toUpperCase();
  const db = mongoose.connection.db;

  const pending = pendingConnections.get(code);
  if (!pending || new Date() > pending.expiresAt) {
    pendingConnections.delete(code);
    return bot.sendMessage(
      chatId,
      "❌ Invalid or expired code. Please generate a new one in the app.",
    );
  }

  await db.collection("bot_connections").updateOne(
    { userId: pending.userId },
    {
      $set: {
        userId: pending.userId,
        telegramId,
        telegramUsername,
        connectedAt: new Date(),
        isActive: true,
      },
    },
    { upsert: true },
  );

  pendingConnections.delete(code);

  bot.sendMessage(
    chatId,
    `✅ *Connected successfully!*\n\n` +
      `You can now send me audio files and they'll appear in your Tel Player app. 🎶\n\n` +
      `Use /mystats to see your account info.`,
    { parse_mode: "Markdown" },
  );
});

bot.onText(/\/disconnect/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const db = mongoose.connection.db;

  const existing = await db
    .collection("bot_connections")
    .findOne({ telegramId, isActive: true });

  if (!existing) {
    return bot.sendMessage(chatId, "You are not connected to any account.");
  }

  await db
    .collection("bot_connections")
    .updateOne({ telegramId }, { $set: { isActive: false } });

  bot.sendMessage(
    chatId,
    "🔌 Disconnected. Send /start to link a new account.",
  );
});

bot.onText(/\/mystats/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const db = mongoose.connection.db;

  const connection = await db
    .collection("bot_connections")
    .findOne({ telegramId, isActive: true });

  if (!connection) {
    return bot.sendMessage(
      chatId,
      "❌ You're not connected to an account. Send /start to get started.",
    );
  }

  const [botSongsCount, user] = await Promise.all([
    db.collection("bot_songs").countDocuments({ userId: connection.userId }),
    db.collection("users").findOne(
      { _id: new mongoose.Types.ObjectId(connection.userId) },
      {
        projection: {
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
          name: 1,
        },
      },
    ),
  ]);

  const isPremium =
    user?.subscriptionExpiresAt &&
    new Date(user.subscriptionExpiresAt) > new Date();

  const expiryDate = isPremium
    ? new Date(user.subscriptionExpiresAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  bot.sendMessage(
    chatId,
    `📊 *Your Account Stats*\n\n` +
      `👤 Name: ${user?.name || "—"}\n` +
      `🎵 Songs sent via bot: ${botSongsCount}\n` +
      `💎 Subscription: ${isPremium ? "Active ✅" : "None ❌"}\n` +
      (isPremium ? `📅 Expires: ${expiryDate}\n` : "") +
      `\nTo manage your subscription, open the Tel Player app.`,
    { parse_mode: "Markdown" },
  );
});

async function _handleAudioMessage(msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const db = mongoose.connection.db;

  const connection = await db
    .collection("bot_connections")
    .findOne({ telegramId, isActive: true });

  if (!connection) {
    return bot.sendMessage(
      chatId,
      "❌ Please connect your account first.\nSend /start to get started.",
    );
  }

  const audio = msg.audio || msg.document;
  if (!audio) return;

  const originalFileId = audio.file_id;

  const exists = await db.collection("bot_songs").findOne({
    userId: connection.userId,
    originalFileId,
  });
  if (exists) {
    return bot.sendMessage(chatId, `⚠️ This track has already been received.`);
  }

  // Forward به کانال storage
  const storageChannel = process.env.BOT_STORAGE_CHANNEL!;
  let storageMessageId: number;
  let storageChannelUsername: string;

  try {
    const forwarded = await bot.forwardMessage(
      storageChannel,
      chatId,
      msg.message_id,
    );
    storageMessageId = forwarded.message_id;
    storageChannelUsername = storageChannel.replace("@", "");
  } catch (err: any) {
    console.error("Failed to forward to storage channel:", err.message);
    return bot.sendMessage(
      chatId,
      "❌ Failed to process your file. Please try again.",
    );
  }

  const title =
    msg.audio?.title ||
    (audio as any).file_name?.replace(/\.[^.]+$/, "") ||
    "Unknown";
  const artist = msg.audio?.performer || "Unknown";
  const duration = msg.audio?.duration || 0;
  const fileSize = audio.file_size || 0;
  const mimeType =
    msg.audio?.mime_type || (audio as any).mime_type || "audio/mpeg";

  // دانلود thumbnail — اگه audio.thumb داشت
  let thumbnail: string | null = null;
  const thumb = (msg.audio as any)?.thumb || (msg.document as any)?.thumb;

  if (thumb?.file_id) {
    try {
      const fileLink = await bot.getFileLink(thumb.file_id);
      const https = require("https");
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        https
          .get(fileLink, (res: any) => {
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", resolve);
            res.on("error", reject);
          })
          .on("error", reject);
      });

      const buffer = Buffer.concat(chunks);
      thumbnail = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    } catch (e: any) {
      console.warn("Failed to download thumbnail:", e.message);
    }
  }

  await db.collection("bot_songs").insertOne({
    userId: connection.userId,
    telegramId,
    originalFileId,
    fileId: originalFileId,
    channelUsername: storageChannelUsername,
    messageId: storageMessageId,
    title,
    artist,
    duration,
    fileSize,
    mimeType,
    thumbnail,
    receivedAt: new Date(),
  });

  const durationStr =
    duration > 0
      ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}`
      : "—";

  bot.sendMessage(
    chatId,
    `✅ *${title}* received!\n` +
      `🎤 ${artist !== "Unknown" ? artist : "Unknown artist"}  •  ⏱ ${durationStr}\n\n` +
      `Open Tel Player to download and play it. 🎵`,
    { parse_mode: "Markdown" },
  );
}

bot.on("audio", _handleAudioMessage);
bot.on("document", async (msg) => {
  if (msg.document?.mime_type?.startsWith("audio/")) {
    await _handleAudioMessage(msg);
  }
});

bot.on("polling_error", (err) => {
  console.error("❌ Bot polling error:", err.message);
});

export async function broadcastMessage(
  message: string,
  targetUserIds?: string[],
): Promise<{ sent: number; failed: number }> {
  const db = mongoose.connection.db;

  const filter: any = { isActive: true };
  if (targetUserIds?.length) filter.userId = { $in: targetUserIds };

  const connections = await db
    .collection("bot_connections")
    .find(filter)
    .toArray();

  let sent = 0,
    failed = 0;

  for (const conn of connections) {
    try {
      await bot.sendMessage(conn.telegramId, message, {
        parse_mode: "Markdown",
      });
      sent++;
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      failed++;
    }
  }

  return { sent, failed };
}

export default bot;
