import { Request, Response, NextFunction } from "express";
import User from "../models/User";
import { generateAuthTokens, verifyToken } from "../utils/jwt";

export const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, name } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ success: false, message: "Email already exists" });

    const user = await User.create({ email, password, name: name || "" });
    const { accessToken, refreshToken } = generateAuthTokens(user);
    user.refreshToken = refreshToken;
    await user.save();

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      data: { user: user.toPublicJSON(), accessToken, refreshToken },
    });
  } catch (error) { next(error); }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select("+password");
    if (!user) return res.status(401).json({ success: false, message: "Invalid email or password" });
    if (!user.isActive) return res.status(401).json({ success: false, message: "Account inactive" });

    const isValid = await user.comparePassword(password);
    if (!isValid) return res.status(401).json({ success: false, message: "Invalid email or password" });

    user.lastLogin = new Date();
    const { accessToken, refreshToken } = generateAuthTokens(user);
    user.refreshToken = refreshToken;
    await user.save();

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: { user: user.toPublicJSON(), accessToken, refreshToken },
    });
  } catch (error) { next(error); }
};

export const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.id);
    res.status(200).json({ success: true, data: { user: user!.toPublicJSON() } });
  } catch (error) { next(error); }
};

export const updateProfile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email } = req.body;
    const user = await User.findById((req as any).user.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    await user.save();
    res.status(200).json({ success: true, message: "Profile updated", data: { user: user.toPublicJSON() } });
  } catch (error) { next(error); }
};

export const updatePassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById((req as any).user.id).select("+password");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const isValid = await user.comparePassword(currentPassword);
    if (!isValid) return res.status(401).json({ success: false, message: "Current password incorrect" });
    user.password = newPassword;
    await user.save();
    res.status(200).json({ success: true, message: "Password updated" });
  } catch (error) { next(error); }
};

export const logout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.id);
    if (user) { user.refreshToken = undefined; await user.save(); }
    res.status(200).json({ success: true, message: "Logout successful" });
  } catch (error) { next(error); }
};

export const refreshToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: "Refresh token required" });
    const decoded = verifyToken(refreshToken);
    const user = await User.findById(decoded.id).select("+refreshToken");
    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({ success: false, message: "Invalid refresh token" });
    }
    const tokens = generateAuthTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();
    res.status(200).json({ success: true, data: tokens });
  } catch (error) { next(error); }
};
