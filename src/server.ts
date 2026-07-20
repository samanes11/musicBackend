import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import connectDB from "./config/database";
import routes from "./routes";
import { errorHandler, notFound } from "./middleware/errorHandler";
import telegramBot from "./services/telegramBot";
import telegramService from "./services/telegram";

const app = express();

// اتصال به MongoDB
connectDB();

app.set("trust proxy", 2);

// Security
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// Rate Limiting
app.use(
  "/api/",
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"),
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "200"),
    message: { success: false, message: "Too many requests, try again later." },
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// CORS
app.use(cors({ origin: process.env.CORS_ORIGIN || "*", credentials: true }));

// Body Parser
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ── Health Check ────────────────────────────────────────────────
const MONGO_STATES: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

function formatUptime(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [d ? `${d}d` : null, h ? `${h}h` : null, m ? `${m}m` : null, `${sec}s`]
    .filter(Boolean)
    .join(" ");
}

app.get("/health", (req, res) => {
  const mem = process.memoryUsage();
  const mongoState = mongoose.connection.readyState;
  const mongoConnected = mongoState === 1;

  let telegramClientConnected = false;
  try {
    telegramClientConnected = telegramService.isConnected();
  } catch {}

  let botPolling = false;
  try {
    botPolling = telegramBot.isPolling();
  } catch {}

  const overallOk = mongoConnected;

  res.status(overallOk ? 200 : 503).json({
    success: overallOk,
    message: overallOk ? "Server is running" : "Server is degraded",
    timestamp: new Date().toISOString(),
    uptime: {
      seconds: Math.floor(process.uptime()),
      human: formatUptime(process.uptime()),
    },
    services: {
      database: {
        connected: mongoConnected,
        status: MONGO_STATES[mongoState] ?? "unknown",
        name: mongoose.connection.name || null,
        host: mongoose.connection.host || null,
      },
      telegram: {
        userClientConnected: telegramClientConnected,
        botPolling,
      },
    },
    system: {
      nodeVersion: process.version,
      env: process.env.NODE_ENV || "development",
      pid: process.pid,
      memoryMb: {
        rss: +(mem.rss / 1024 / 1024).toFixed(1),
        heapUsed: +(mem.heapUsed / 1024 / 1024).toFixed(1),
        heapTotal: +(mem.heapTotal / 1024 / 1024).toFixed(1),
      },
    },
  });
});

// API Routes
app.use("/api", routes);

// Error Handlers
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`🌍 Mode: ${process.env.NODE_ENV || "development"}`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
  console.log(`📡 API:    http://localhost:${PORT}/api`);
});

process.on("unhandledRejection", (err: any) => {
  console.error(`❌ Unhandled Rejection: ${err.message}`);
  process.exit(1);
});

export default app;
