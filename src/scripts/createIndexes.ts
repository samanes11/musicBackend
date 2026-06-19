/**
 * Run once:  npx ts-node src/scripts/createIndexes.ts
 *
 * Safe to re-run — MongoDB skips existing indexes automatically.
 */
import mongoose from "mongoose";
import "dotenv/config";

async function createIndexes() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set in .env");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`\n🔌 Connected to: ${mongoose.connection.host}/${mongoose.connection.name}`);

  /* ─────────────────────────────────────────────
     telegram_songs  (heaviest collection)
  ───────────────────────────────────────────── */
  await db.collection("telegram_songs").createIndex(
    { channelDbId: 1, messageDate: -1 },
    { name: "songs_channel_date", background: true }
  );
  console.log("✅ songs: channelDbId + messageDate");

  await db.collection("telegram_songs").createIndex(
    { channelDbId: 1, messageId: -1 },
    { name: "songs_channel_msgid", background: true }
  );
  console.log("✅ songs: channelDbId + messageId  (incremental sync)");

  await db.collection("telegram_songs").createIndex(
    { title: "text", artist: "text" },
    { weights: { title: 2, artist: 1 }, name: "songs_text_search", background: true }
  );
  console.log("✅ songs: text search index");

  /* ─────────────────────────────────────────────
     telegram_channels
  ───────────────────────────────────────────── */
  await db.collection("telegram_channels").createIndex(
    { userId: 1, addedAt: -1 },
    { name: "channels_user_date", background: true }
  );
  console.log("✅ channels: userId + addedAt");

  await db.collection("telegram_channels").createIndex(
    { userId: 1, channelUsername: 1 },
    { unique: true, name: "channels_user_username_unique", background: true }
  );
  console.log("✅ channels: userId + channelUsername  (unique)");

  await db.collection("telegram_channels").createIndex(
    { status: 1 },
    { name: "channels_status", background: true }
  );
  console.log("✅ channels: status");

  /* ─────────────────────────────────────────────
     user_favorites
  ───────────────────────────────────────────── */
  await db.collection("user_favorites").createIndex(
    { userId: 1, addedAt: -1 },
    { name: "favorites_user_date", background: true }
  );
  console.log("✅ favorites: userId + addedAt");

  await db.collection("user_favorites").createIndex(
    { userId: 1, songId: 1 },
    { unique: true, name: "favorites_user_song_unique", background: true }
  );
  console.log("✅ favorites: userId + songId  (unique — prevents duplicates)");

  /* ─────────────────────────────────────────────
     user_playlists
  ───────────────────────────────────────────── */
  await db.collection("user_playlists").createIndex(
    { userId: 1, updatedAt: -1 },
    { name: "playlists_user_date", background: true }
  );
  console.log("✅ playlists: userId + updatedAt");

  /* ─────────────────────────────────────────────
     user_downloads
  ───────────────────────────────────────────── */
  await db.collection("user_downloads").createIndex(
    { userId: 1, status: 1 },
    { name: "downloads_user_status", background: true }
  );
  console.log("✅ downloads: userId + status");

  await db.collection("user_downloads").createIndex(
    { userId: 1, songId: 1 },
    { name: "downloads_user_song", background: true }
  );
  console.log("✅ downloads: userId + songId");

  /* ─────────────────────────────────────────────
     stream_tokens  —  TTL auto-cleanup
  ───────────────────────────────────────────── */
  await db.collection("stream_tokens").createIndex(
    { token: 1 },
    { unique: true, name: "stream_token_unique", background: true }
  );
  console.log("✅ stream_tokens: token  (unique)");

  await db.collection("stream_tokens").createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "stream_tokens_ttl", background: true }
  );
  console.log("✅ stream_tokens: TTL on expiresAt  (auto-delete expired)");

  /* ─────────────────────────────────────────────
     default_channels
  ───────────────────────────────────────────── */
  await db.collection("default_channels").createIndex(
    { channelUsername: 1 },
    { unique: true, name: "default_channels_username_unique", background: true }
  );
  console.log("✅ default_channels: channelUsername  (unique)");

  /* ─────────────────────────────────────────────
     Summary
  ───────────────────────────────────────────── */
  console.log("\n🎉 All indexes created successfully!\n");

  // Print index report
  const collections = [
    "telegram_songs", "telegram_channels",
    "user_favorites", "user_playlists",
    "user_downloads", "stream_tokens", "default_channels",
  ];

  for (const col of collections) {
    const indexes = await db.collection(col).indexes();
    console.log(`📋 ${col}:`);
    for (const idx of indexes) {
      console.log(`   - ${idx.name}:`, JSON.stringify(idx.key));
    }
  }

  await mongoose.disconnect();
  console.log("\n✅ Done — connection closed.");
}

createIndexes().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
