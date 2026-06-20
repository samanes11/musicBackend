/**
 * Migration 05 — default_channels → env / config file
 *
 * قبل:  یه collection با چند رکورد که به ندرت عوض میشه
 * بعد:  یه JSON file یا env variable
 *
 * اجرا:  npx ts-node src/migrations/05_export_default_channels.ts
 *
 * بعد از اجرا:
 * 1. فایل default_channels.json ساخته میشه
 * 2. محتواش رو به DEFAULT_CHANNELS در .env اضافه کن
 * 3. collection رو drop کن
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import mongoose from "mongoose";
import fs from "fs";


async function run() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db;
  console.log("Connected");

  const channels = await db
    .collection("default_channels")
    .find()
    .sort({ addedAt: 1 })
    .toArray();

  console.log(`📊 default_channels: ${channels.length} records`);

  if (channels.length === 0) {
    console.log("ℹ️  No default channels configured.");
    await mongoose.disconnect();
    return;
  }

  // export به JSON
  const exported = channels.map((c) => ({
    username: c.channelUsername,
    name: c.channelName,
  }));

  const outPath = path.join(process.cwd(), "default_channels.json");
  fs.writeFileSync(outPath, JSON.stringify(exported, null, 2));
  console.log(`✅ Exported to: ${outPath}`);

  // نشون بده چطور به .env اضافه کنه
  const envValue = JSON.stringify(exported);
  console.log(`
📝 Add this to your .env:`);
  console.log(`DEFAULT_CHANNELS='${envValue}'
`);

  console.log(`
⚠️  After verifying the config, run in MongoDB shell:`);
  console.log(`   db.default_channels.drop()
`);

  await mongoose.disconnect();
}

run().catch((e) => { console.error("❌", e); process.exit(1); });
