import type { Request } from "express";
import type { Role } from "../../../generated/prisma/enums.js";
import type { RequestUser } from "../../lib/request-user.js";

/** The signed-in user as the API and the web app see it. Never includes the password hash. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** What the middleware attaches to a request after a valid session cookie was found. */
export interface AuthSession {
  id: string;
  csrfToken: string;
  user: AuthUser;
}

export type AuthedRequest = Request & { user?: RequestUser; authSession?: AuthSession };

export const SESSION_COOKIE = "sid";
export const CSRF_HEADER = "x-csrf-token";
