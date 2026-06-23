import TelegramBot, { Message } from "node-telegram-bot-api";
import mongoose from "mongoose";
import crypto from "crypto";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const pendingConnections = new Map<string, { userId: string; expiresAt: Date }>();

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

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const db = mongoose.connection.db;

  const existing = await db
    .collection("bot_connections")
    .findOne({ telegramId, isActive: true });

  if (existing) {
    return bot.sendMessage(
      chatId,
      `✅ *You're already connected to Tel Player!*\n\n` +
        `Send me any audio file and it will appear in your app.\n\n` +
        `Commands:\n` +
        `/mystats — View your account stats\n` +
        `/disconnect — Unlink this account`,
      { parse_mode: "Markdown" }
    );
  }

  bot.sendMessage(
    chatId,
    `🎵 *Welcome to Tel Player Bot!*\n\n` +
      `To link your account:\n` +
      `1. Open the Tel Player app\n` +
      `2. Go to Settings → Connect Bot\n` +
      `3. Send the 6-character code shown there\n\n` +
      `Already have a code? Send it now.`,
    { parse_mode: "Markdown" }
  );
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
      "❌ Invalid or expired code. Please generate a new one in the app."
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
    { upsert: true }
  );

  pendingConnections.delete(code);

  bot.sendMessage(
    chatId,
    `✅ *Connected successfully!*\n\n` +
      `You can now send me audio files and they'll appear in your Tel Player app. 🎶\n\n` +
      `Use /mystats to see your account info.`,
    { parse_mode: "Markdown" }
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
    "🔌 Disconnected. Send /start to link a new account."
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
      "❌ You're not connected to an account. Send /start to get started."
    );
  }

  const [botSongsCount, user] = await Promise.all([
    db
      .collection("bot_songs")
      .countDocuments({ userId: connection.userId }),
    db.collection("users").findOne(
      { _id: new mongoose.Types.ObjectId(connection.userId) },
      { projection: { subscriptionPlan: 1, subscriptionExpiresAt: 1, name: 1 } }
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
    { parse_mode: "Markdown" }
  );
});

async function _handleAudioMessage(msg: Message) {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const db = mongoose.connection.db;

  const connection = await db
    .collection("bot_connections")
    .findOne({ telegramId, isActive: true });

  if (!connection) {
    return bot.sendMessage(
      chatId,
      "❌ Please connect your account first.\nSend /start to get started."
    );
  }

  const audio = msg.audio || msg.document;
  if (!audio) return;

  const fileId = audio.file_id;
  const fileName =
    msg.audio?.file_name || msg.document?.file_name || "unknown.mp3";
  const title = msg.audio?.title || fileName.replace(/\.[^.]+$/, "");
  const artist = msg.audio?.performer || "Unknown";
  const duration = msg.audio?.duration || 0;
  const fileSize = audio.file_size || 0;
  const mimeType =
    msg.audio?.mime_type || msg.document?.mime_type || "audio/mpeg";

  const exists = await db
    .collection("bot_songs")
    .findOne({ userId: connection.userId, fileId });

  if (exists) {
    return bot.sendMessage(chatId, `⚠️ This track has already been received.`);
  }

  await db.collection("bot_songs").insertOne({
    userId: connection.userId,
    telegramId,
    fileId,
    fileName,
    title,
    artist,
    duration,
    fileSize,
    mimeType,
    messageId: msg.message_id,
    thumbnail: null,
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
    { parse_mode: "Markdown" }
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
  targetUserIds?: string[]
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