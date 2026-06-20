/**
 * Migration 01 — user_proxy_settings → users.proxy
 *
 * اجرا:     npx ts-node src/migrations/01_embed_proxy_into_users.ts
 * Rollback: npx ts-node src/migrations/01_embed_proxy_into_users.ts --rollback
 */

// ← dotenv باید اول از همه لود بشه
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import mongoose from "mongoose";

const ROLLBACK = process.argv.includes("--rollback");

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI not found in .env");
    console.error(`   Looking for .env at: ${path.resolve(process.cwd(), ".env.local")}`);
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`\n🔌 Connected — mode: ${ROLLBACK ? "ROLLBACK" : "MIGRATE"}\n`);

  if (ROLLBACK) {
    const users = await db
      .collection("users")
      .find({ proxy: { $exists: true } })
      .toArray();

    let count = 0;
    for (const user of users) {
      if (!user.proxy) continue;
      await db.collection("user_proxy_settings").updateOne(
        { userId: user._id.toString() },
        {
          $set: {
            userId:        user._id.toString(),
            proxyType:     user.proxy.type     ?? "none",
            proxyHost:     user.proxy.host     ?? "",
            proxyPort:     user.proxy.port     ?? 0,
            proxyUsername: user.proxy.username ?? "",
            proxyPassword: user.proxy.password ?? "",
            proxySecret:   user.proxy.secret   ?? "",
            updatedAt:     new Date(),
          },
        },
        { upsert: true }
      );
      await db
        .collection("users")
        .updateOne({ _id: user._id }, { $unset: { proxy: "" } });
      count++;
    }
    console.log(`✅ Rollback complete — ${count} users restored to user_proxy_settings`);
  } else {
    const proxies = await db.collection("user_proxy_settings").find().toArray();
    console.log(`📊 Found ${proxies.length} records in user_proxy_settings`);

    let migrated = 0;
    let skipped  = 0;

    for (const p of proxies) {
      if (!p.proxyType || p.proxyType === "none") {
        skipped++;
        continue;
      }

      const result = await db.collection("users").updateOne(
        { _id: new mongoose.Types.ObjectId(p.userId) },
        {
          $set: {
            proxy: {
              type:     p.proxyType,
              host:     p.proxyHost     || "",
              port:     p.proxyPort     || 0,
              username: p.proxyUsername || "",
              password: p.proxyPassword || "",
              secret:   p.proxySecret   || "",
            },
          },
        }
      );

      if (result.modifiedCount > 0) migrated++;
      else skipped++;
    }

    console.log(`✅ Migrated: ${migrated} | Skipped (no proxy / user not found): ${skipped}`);
    console.log(`\n⚠️  Verify the data, then run in MongoDB shell:`);
    console.log(`   db.user_proxy_settings.drop()\n`);
  }

  await mongoose.disconnect();
  console.log("🔌 Disconnected");
}

run().catch((e) => { console.error("❌", e.message); process.exit(1); });
