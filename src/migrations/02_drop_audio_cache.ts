/**
 * Migration 02 — audio_cache collection حذف میشه
 *
 * این collection دیگه استفاده نمیشه چون streamController.ts
 * رفته سمت disk cache. ولی downloadsController.ts هنوز داره
 * توش می‌نویسه — اون هم در فیکس بعدی درست میشه.
 *
 * اجرا:   npx ts-node src/migrations/02_drop_audio_cache.ts
 * Rollback: غیرممکن — داده‌ها از دست میرن (ولی فایل‌ها روی دیسک هستن)
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import mongoose from "mongoose";


async function run() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db;
  console.log(" Connected");

  // آمار قبل از حذف
  const count = await db.collection("audio_cache").countDocuments();
  const stats = await db.command({ collStats: "audio_cache" }).catch(() => null);
  const sizeMB = stats ? (stats.size / 1024 / 1024).toFixed(1) : "?";

  console.log(`📊 audio_cache: ${count} documents, ~${sizeMB} MB`);

  if (count === 0) {
    console.log("✅ Collection already empty — dropping...");
  } else {
    console.log(`⚠️  About to drop ${count} cached audio blobs from MongoDB.`);
    console.log(`   These are already served from disk cache — safe to drop.`);
    console.log(`   Files on disk at AUDIO_CACHE_DIR are NOT affected.
`);
  }

  await db.collection("audio_cache").drop().catch((e) => {
    if (e.message?.includes("ns not found")) {
      console.log("ℹ️  Collection did not exist — nothing to do.");
    } else {
      throw e;
    }
  });

  console.log("✅ audio_cache dropped successfully");
  console.log(`💾 MongoDB space freed: ~${sizeMB} MB
`);

  await mongoose.disconnect();
}

run().catch((e) => { console.error("❌", e); process.exit(1); });
