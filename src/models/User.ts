import mongoose, { Document, Schema } from "mongoose";
import bcrypt from "bcryptjs";

export interface IUser extends Document {
  email: string;
  password: string;
  name: string;
  isActive: boolean;
  lastLogin: Date | null;
  refreshToken?: string;
  subscriptionPlan: string | null;
  subscriptionExpiresAt: Date | null;
  comparePassword(candidatePassword: string): Promise<boolean>;
  toPublicJSON(): object;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 6,
      select: false,
    },
    name: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },
    refreshToken: { type: String, select: false },
    subscriptionPlan: { type: String, default: null },
    subscriptionExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = async function (
  candidatePassword: string,
): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toPublicJSON = function () {
  return {
    id: this._id,
    email: this.email,
    name: this.name,
    isActive: this.isActive,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    lastLogin: this.lastLogin,
    subscriptionPlan: this.subscriptionPlan,
    subscriptionExpiresAt: this.subscriptionExpiresAt,
  };
};

userSchema.index({ email: 1 });

export default mongoose.model<IUser>("User", userSchema);
