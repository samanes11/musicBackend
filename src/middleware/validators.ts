import { body, validationResult } from "express-validator";
import { Request, Response, NextFunction } from "express";

export const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: errors.array().map((e: any) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

export const registerValidation = [
  body("email").isEmail().withMessage("Valid email required").normalizeEmail(),
  body("password")
    .isLength({ min: 6 }).withMessage("Password min 6 chars")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage("Password must have upper, lower, number"),
  body("name").optional().trim().isLength({ min: 2 }).withMessage("Name min 2 chars"),
  validate,
];

export const loginValidation = [
  body("email").isEmail().withMessage("Valid email required").normalizeEmail(),
  body("password").notEmpty().withMessage("Password required"),
  validate,
];

export const updatePasswordValidation = [
  body("currentPassword").notEmpty().withMessage("Current password required"),
  body("newPassword")
    .isLength({ min: 6 }).withMessage("New password min 6 chars")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage("Password must have upper, lower, number"),
  validate,
];

export const updateProfileValidation = [
  body("name").optional().trim().isLength({ min: 2 }).withMessage("Name min 2 chars"),
  body("email").optional().isEmail().withMessage("Valid email required").normalizeEmail(),
  validate,
];
