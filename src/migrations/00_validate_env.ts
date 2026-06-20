/**
 * قبل از هر migration این رو اجرا کن:
 * npx ts-node src/migrations/00_validate_env.ts
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

const envPath = path.resolve(process.cwd(), ".env.local");
console.log(`\n🔍 Looking for .env at: ${envPath}`);

if (!fs.existsSync(envPath)) {
  console.error(`❌ .env file not found at: ${envPath}`);
  console.error(`   Make sure you run this from the project root (where .env is)`);
  process.exit(1);
}

dotenv.config({ path: envPath });

const checks: Array<{ key: string; required: boolean }> = [
  { key: "MONGODB_URI",   required: true  },
  { key: "JWT_SECRET",    required: true  },
  { key: "STREAM_TOKEN_SECRET", required: false },
  { key: "DEFAULT_CHANNELS",    required: false },
  { key: "AUDIO_CACHE_DIR",     required: false },
];

let hasError = false;

for (const check of checks) {
  const val = process.env[check.key];
  if (!val && check.required) {
    console.error(`❌ Missing required: ${check.key}`);
    hasError = true;
  } else if (!val) {
    console.warn(`⚠️  Optional missing: ${check.key} (will use default)`);
  } else {
    // مقدار رو به صورت masked نشون بده
    const masked = val.length > 20
      ? val.substring(0, 8) + "..." + val.substring(val.length - 4)
      : "***";
    console.log(`✅ ${check.key}: ${masked}`);
  }
}

if (hasError) {
  console.error(`\n❌ Fix the errors above before running migrations\n`);
  process.exit(1);
}

// تست connection
import mongoose from "mongoose";

async function testConnection() {
  try {
    await mongoose.connect(process.env.MONGODB_URI!);
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const names = collections.map((c: any) => c.name).sort();

    console.log(`\n✅ MongoDB connected: ${mongoose.connection.host}`);
    console.log(`📦 Database: ${mongoose.connection.name}`);
    console.log(`📋 Collections (${names.length}):`);
    names.forEach((n: string) => console.log(`   - ${n}`));

    await mongoose.disconnect();
    console.log(`\n✅ All checks passed — ready to run migrations\n`);
  } catch (e: any) {
    console.error(`\n❌ MongoDB connection failed: ${e.message}\n`);
    process.exit(1);
  }
}

testConnection();
