import User from "../models/User";
import { applyDefaultChannelsForNewUser } from "../controllers/defaultChannelsController";

export async function authenticateTelegramUser({
  telegramId,
  telegramUsername,
  name,
}: {
  telegramId: string | number;
  telegramUsername?: string | null;
  name?: string | null;
}): Promise<{ user: any; isNew: boolean }> {
  if (!telegramId) {
    throw new Error("telegramId required");
  }

  let user = await User.findOne({ telegramId: telegramId.toString() });
  let isNew = false;

  if (!user) {
    user = await User.create({
      telegramId: telegramId.toString(),
      telegramUsername: telegramUsername || null,
      name: name || telegramUsername || "User",
      isActive: true,
      profileComplete: false,
      role: "user",
    });
    isNew = true;
  } else {
    user.telegramUsername = telegramUsername || user.telegramUsername;
    if (!user.isActive) {
      throw new Error("Account inactive");
    }
  }

  user.lastLogin = new Date();
  await user.save();

  if (isNew) applyDefaultChannelsForNewUser(user._id).catch(console.error);

  return { user, isNew };
}