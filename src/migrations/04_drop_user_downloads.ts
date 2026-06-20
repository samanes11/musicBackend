/**
 * Migration 04 — user_downloads پاک‌سازی
 *
 * این collection فقط برای track کردن وضعیت دانلود استفاده میشه.
 * وقتی فایل روی دیسک سرور هست، رکورد "completed" دیگه ارزشی نداره.
 * رکوردهای "downloading" و "waiting" هم بعد از restart سرور invalid هستن.
 *
 * بعد از این migration:
 * - collection حذف میشه
 * - Flutter state از disk cache می‌خونه (قبلاً اینطور بود)
 *
 * اجرا:  npx ts-node src/migrations/04_drop_user_downloads.ts
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import mongoose from "mongoose";


async function run() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db;
  console.log(" Connected");

  // آمار
  const [total, completed, failed, downloading] = await Promise.all([
    db.collection("user_downloads").countDocuments(),
    db.collection("user_downloads").countDocuments({ status: "completed" }),
    db.collection("user_downloads").countDocuments({ status: "failed" }),
    db.collection("user_downloads").countDocuments({
      status: { $in: ["downloading", "waiting"] },
    }),
  ]);

  console.log(`📊 user_downloads breakdown:`);
  console.log(`   Total:       ${total}`);
  console.log(`   Completed:   ${completed}  ← فایل روی دیسک، رکورد بی‌ارزش`);
  console.log(`   Failed:      ${failed}   ← می‌تونه حذف بشه`);
  console.log(`   In-progress: ${downloading} ← بعد از restart invalid هستن`);
  console.log(``);

  await db.collection("user_downloads").drop().catch((e) => {
    if (e.message?.includes("ns not found")) {
      console.log("ℹ️  Collection did not exist.");
    } else throw e;
  });

  console.log("✅ user_downloads dropped");
  await mongoose.disconnect();
}

run().catch((e) => { console.error("❌", e); process.exit(1); });
