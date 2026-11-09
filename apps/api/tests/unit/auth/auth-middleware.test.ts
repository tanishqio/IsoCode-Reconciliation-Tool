import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../../src/middleware/error-handler.js";
import { requestLogger } from "../../../src/middleware/request-logger.js";
import { getRequestUser, requireRole } from "../../../src/lib/request-user.js";
import {
  createAuthMiddleware,
  sessionCookieOptions,
} from "../../../src/modules/auth/auth.middleware.js";
import type { AuthService } from "../../../src/modules/auth/auth.service.js";
import type { AuthSession } from "../../../src/modules/auth/auth.types.js";
import { call } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";

const executive: AuthSession = {
  id: "s1",
  csrfToken: "csrf-for-exec",
  user: { id: "u1", name: "Exec", email: "exec@example.test", role: "FINANCE_EXECUTIVE" },
};
const founder: AuthSession = {
  id: "s2",
  csrfToken: "csrf-for-founder",
  user: { id: "u2", name: "Founder", email: "founder@example.test", role: "CO_FOUNDER" },
};

// A fake service: knows two tokens and nothing else.
const getSession = vi.fn(async (token: string) =>
  token === "exec-token" ? executive : token === "founder-token" ? founder : null,
);
const service = { getSession } as unknown as AuthService;

let server: TestServer;
beforeAll(async () => {
  const { authenticate, csrfProtection } = createAuthMiddleware({ service });
  const app = express();
  app.use(requestLogger);
  app.use(cookieParser());
  app.get("/read", authenticate, csrfProtection, (req, res) =>
    res.json({ user: getRequestUser(req) }),
  );
  app.post("/write", authenticate, csrfProtection, (req, res) =>
    res.json({ user: getRequestUser(req) }),
  );
  app.delete("/write", authenticate, csrfProtection, (_req, res) => res.json({ ok: true }));
  app.post(
    "/exec-only",
    authenticate,
    csrfProtection,
    requireRole("FINANCE_EXECUTIVE"),
    (_req, res) => res.json({ ok: true }),
  );
  app.post("/csrf-without-auth", csrfProtection, (_req, res) => res.json({ ok: true }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  server = await startServer(app);
});
afterAll(async () => {
  await server.close();
});

const base = () => server.baseUrl;

describe("authenticate", () => {
  it("answers 401 with no cookie, and does not look anything up", async () => {
    getSession.mockClear();
    const result = await call(base(), "GET", "/read");
    expect(result.status).toBe(401);
    expect(result.data.error.code).toBe("UNAUTHENTICATED");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("answers 401 for an empty cookie", async () => {
    expect((await call(base(), "GET", "/read", { cookie: "sid=" })).status).toBe(401);
  });

  it("answers 401 for an unknown token and clears the cookie", async () => {
    const result = await call(base(), "GET", "/read", { cookie: "sid=forged" });
    expect(result.status).toBe(401);
    expect(result.setCookies.some((value) => /^sid=;/.test(value))).toBe(true);
  });

  it("lets a valid session through and sets req.user to the id and role only", async () => {
    const result = await call(base(), "GET", "/read", { cookie: "sid=exec-token" });
    expect(result.status).toBe(200);
    expect(result.data.user).toEqual({ id: "u1", role: "FINANCE_EXECUTIVE" });
  });
});

describe("csrfProtection", () => {
  it("does not check reads", async () => {
    expect((await call(base(), "GET", "/read", { cookie: "sid=exec-token" })).status).toBe(200);
  });

  it("refuses a write with no token, a wrong token, or another user's token (403)", async () => {
    for (const csrf of [undefined, "wrong", founder.csrfToken, ""]) {
      const post = await call(base(), "POST", "/write", { cookie: "sid=exec-token", csrf });
      expect(post.status, String(csrf)).toBe(403);
      expect(post.data.error.code).toBe("FORBIDDEN");
    }
    expect((await call(base(), "DELETE", "/write", { cookie: "sid=exec-token" })).status).toBe(403);
  });

  it("lets a write through with the session's own token", async () => {
    const post = await call(base(), "POST", "/write", {
      cookie: "sid=exec-token",
      csrf: executive.csrfToken,
    });
    expect(post.status).toBe(200);
    const del = await call(base(), "DELETE", "/write", {
      cookie: "sid=exec-token",
      csrf: executive.csrfToken,
    });
    expect(del.status).toBe(200);
  });

  it("refuses a write when no session was found first (it is not a way around signing in)", async () => {
    const result = await call(base(), "POST", "/csrf-without-auth", { csrf: "anything" });
    expect(result.status).toBe(403);
  });
});

describe("role check after authentication", () => {
  it("lets the finance executive through and refuses the co-founder with 403", async () => {
    const ok = await call(base(), "POST", "/exec-only", {
      cookie: "sid=exec-token",
      csrf: executive.csrfToken,
    });
    expect(ok.status).toBe(200);
    const refused = await call(base(), "POST", "/exec-only", {
      cookie: "sid=founder-token",
      csrf: founder.csrfToken,
    });
    expect(refused.status).toBe(403);
    expect(refused.data.error.code).toBe("FORBIDDEN");
  });
});

describe("session cookie settings", () => {
  it("are HttpOnly, SameSite=Lax and for the whole site", () => {
    expect(sessionCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("add the lifetime only when one is given", () => {
    expect(sessionCookieOptions(1000)).toMatchObject({ maxAge: 1000 });
    expect("maxAge" in sessionCookieOptions()).toBe(false);
  });

  it("are not Secure outside production, so sign-in works over http://localhost", () => {
    expect(sessionCookieOptions().secure).toBe(false);
  });
});
