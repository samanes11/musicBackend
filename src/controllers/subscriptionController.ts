import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import crypto from "crypto";

// ── پلن‌های اشتراک — هر وقت خواستی قیمت/مدت رو عوض کن ─────────────
export const SUBSCRIPTION_PLANS: Record<
  string,
  { id: string; title: string; days: number; price: number }
> = {
  "1m": { id: "1m", title: "۱ ماهه", days: 30, price: 49000 },
  "3m": { id: "3m", title: "۳ ماهه", days: 90, price: 119000 },
  "6m": { id: "6m", title: "۶ ماهه", days: 180, price: 199000 },
};
// ── آدرس درگاه پرداخت خودت رو این‌جا یا در .env (PAYMENT_GATEWAY_URL) بذار ──
const PAYMENT_GATEWAY_URL =
  process.env.PAYMENT_GATEWAY_URL || "https://example.com/pay";
const PUBLIC_API_URL =
  process.env.PUBLIC_API_URL ||
  "https://musicbackend-production-7d94.up.railway.app/api";

// ── POST /api/subscription/order ──────────────────────────────────
// ── POST /api/subscription/order ──────────────────────────────────
export const createSubscriptionOrder = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { planId } = req.body;

    const plan = SUBSCRIPTION_PLANS[planId];
    if (!plan) {
      return res.status(400).json({ success: false, message: "پلن نامعتبر است" });
    }

    const db = mongoose.connection.db;
    const orderId = crypto.randomBytes(12).toString("hex");

    // ─────────────────────────────────────────────────────────
    // 🧪 TEST MODE — فقط برای تست، قبل از پروداکشن این بلوک رو حذف کن
    // ─────────────────────────────────────────────────────────
    const TEST_MODE = true; // ← وقتی رفتی پروداکشن، این رو false کن یا کل بلوک رو پاک کن

    if (TEST_MODE) {
      await db.collection("subscription_orders").insertOne({
        orderId,
        userId,
        planId: plan.id,
        days: plan.days,
        amount: plan.price,
        status: "paid",
        createdAt: new Date(),
        paidAt: new Date(),
        testMode: true,
      });

      await _extendUserSubscription(userId, plan.id, plan.days, db);

      return res.json({
        success: true,
        data: {
          orderId,
          paymentUrl: null,
          testMode: true,
          amount: plan.price,
          plan: plan.title,
        },
      });
    }
    // ─────────────────────────────────────────────────────────
    // پایان بلوک تست
    // ─────────────────────────────────────────────────────────

    await db.collection("subscription_orders").insertOne({
      orderId,
      userId,
      planId: plan.id,
      days: plan.days,
      amount: plan.price,
      status: "pending",
      createdAt: new Date(),
    });

    const callbackUrl = `${PUBLIC_API_URL}/subscription/callback?orderId=${orderId}`;
    const paymentUrl =
      `${PAYMENT_GATEWAY_URL}?orderId=${orderId}` +
      `&amount=${plan.price}` +
      `&callback=${encodeURIComponent(callbackUrl)}`;

    res.json({
      success: true,
      data: { orderId, paymentUrl, amount: plan.price, plan: plan.title },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/subscription/callback ────────────────────────────────
// درگاه پرداخت، بعد از تکمیل، کاربر رو به این آدرس برمی‌گردونه
export const subscriptionCallback = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { orderId, status } = req.query as {
      orderId?: string;
      status?: string;
    };
    const db = mongoose.connection.db;

    const order = await db
      .collection("subscription_orders")
      .findOne({ orderId });
    if (!order)
      return res.status(404).send(_resultPage(false, "سفارش پیدا نشد"));

    if (order.status === "paid") {
      return res.send(_resultPage(true, "این پرداخت قبلاً تایید شده است"));
    }

    const isSuccess = status === "success" || status === "OK" || status === "1";
    if (!isSuccess) {
      await db
        .collection("subscription_orders")
        .updateOne(
          { orderId },
          { $set: { status: "failed", failedAt: new Date() } },
        );
      return res.send(_resultPage(false, "پرداخت ناموفق بود"));
    }

    // TODO: این‌جا verify واقعی تراکنش با درگاه خودت رو اضافه کن
    // (مثلاً درخواست verify به Zarinpal/IDPay با authority/trackId قبل از تایید نهایی)

    await db
      .collection("subscription_orders")
      .updateOne({ orderId }, { $set: { status: "paid", paidAt: new Date() } });

    await _extendUserSubscription(order.userId, order.planId, order.days, db);

    res.send(_resultPage(true, "اشتراک شما با موفقیت فعال شد 🎉"));
  } catch (error) {
    next(error);
  }
};

async function _extendUserSubscription(
  userId: string,
  planId: string,
  days: number,
  db: any,
) {
  const user = await db
    .collection("users")
    .findOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { projection: { subscriptionExpiresAt: 1 } },
    );

  const now = new Date();
  const base =
    user?.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now
      ? new Date(user.subscriptionExpiresAt)
      : now;

  const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  await db
    .collection("users")
    .updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { subscriptionPlan: planId, subscriptionExpiresAt: newExpiry } },
    );
}

function _resultPage(success: boolean, message: string): string {
  return `<!DOCTYPE html><html dir="rtl" lang="fa"><head><meta charset="utf-8">
  <title>نتیجه پرداخت</title>
  <style>
    body{font-family:sans-serif;background:#09090b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{text-align:center;padding:32px;border-radius:20px;background:#18181b;border:1px solid #27272a}
    .icon{font-size:48px;margin-bottom:12px}
    .ok{color:#22c55e}.fail{color:#ef4444}
    p{color:#a1a1aa}
  </style></head><body>
    <div class="box">
      <div class="icon ${success ? "ok" : "fail"}">${success ? "✓" : "✕"}</div>
      <h2>${success ? "پرداخت موفق" : "پرداخت ناموفق"}</h2>
      <p>${message}</p>
      <p style="font-size:13px;margin-top:16px">می‌توانید به اپلیکیشن برگردید.</p>
    </div>
  </body></html>`;
}

// ── GET /api/subscription/order/:orderId/status ───────────────────
export const getOrderStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { orderId } = req.params;
    const db = mongoose.connection.db;

    const order = await db
      .collection("subscription_orders")
      .findOne({ orderId, userId });

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "سفارش پیدا نشد" });
    }

    res.json({
      success: true,
      data: {
        orderId: order.orderId,
        status: order.status,
        planId: order.planId,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/subscription/status ───────────────────────────────────
export const getSubscriptionStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    const user = await db
      .collection("users")
      .findOne(
        { _id: new mongoose.Types.ObjectId(userId) },
        { projection: { subscriptionPlan: 1, subscriptionExpiresAt: 1 } },
      );

    const expiresAt = user?.subscriptionExpiresAt ?? null;
    const isPremium = !!expiresAt && new Date(expiresAt) > new Date();

    res.json({
      success: true,
      data: {
        isPremium,
        subscriptionPlan: user?.subscriptionPlan ?? null,
        subscriptionExpiresAt: expiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getPlans = async (_req: Request, res: Response) => {
  res.json({ success: true, data: Object.values(SUBSCRIPTION_PLANS) });
};
