import type { Request, RequestHandler } from "express";
import { AppError } from "./errors.js";

export type UserRole = "FINANCE_EXECUTIVE" | "CO_FOUNDER";

export interface RequestUser {
  id: string;
  role: UserRole;
}

export function getRequestUser(req: Request): RequestUser {
  const user = (req as Request & { user?: RequestUser }).user;
  if (!user) throw new AppError("UNAUTHENTICATED", 401, "Please sign in.");
  return user;
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const user = getRequestUser(req);
    if (!roles.includes(user.role)) {
      next(new AppError("FORBIDDEN", 403, "You do not have access to this."));
      return;
    }
    next();
  };
}
