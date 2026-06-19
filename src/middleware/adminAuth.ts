import { Request, Response, NextFunction } from "express";

// ساده‌ترین راه برای محافظت از روت‌های ادمین:
// یک کلید ثابت در .env به اسم ADMIN_SECRET تعریف کن
// و توی پنل ادمین همون کلید رو بفرست (هدر x-admin-key)
export const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const key = req.headers["x-admin-key"];
  const secret = process.env.ADMIN_SECRET;

  if (!secret) {
    return res.status(500).json({ success: false, message: "ADMIN_SECRET not configured on server" });
  }
  if (!key || key !== secret) {
    return res.status(401).json({ success: false, message: "Invalid admin key" });
  }
  next();
};