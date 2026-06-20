/**
 * Migration 03 — stream_tokens collection حذف میشه
 *
 * قبل:  توکن رندوم در DB ذخیره میشد، هر request یه DB lookup داشت
 * بعد:  JWT sign شده — بدون DB، بدون lookup
 *
 * اجرا:  npx ts-node src/migrations/03_drop_stream_tokens.ts
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import mongoose from "mongoose";


async function run() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db;
  console.log("Connected");

  const count = await db.collection("stream_tokens").countDocuments();
  console.log(`📊 stream_tokens: ${count} documents (all are short-lived, max 1hr)`);
  console.log(`   Active tokens will be invalidated — clients will re-request.
`);

  await db.collection("stream_tokens").drop().catch((e) => {
    if (e.message?.includes("ns not found")) {
      console.log("ℹ️  Collection did not exist — nothing to do.");
    } else throw e;
  });

  console.log("✅ stream_tokens dropped");
  await mongoose.disconnect();
}

run().catch((e) => { console.error("❌", e); process.exit(1); });
