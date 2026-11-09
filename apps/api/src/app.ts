import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { createAuthMiddleware } from "./modules/auth/auth.middleware.js";
import { createAuthRouter, createLoginRateLimiter } from "./modules/auth/auth.routes.js";
import { createAuthService } from "./modules/auth/auth.service.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { createRateCardsRouter } from "./modules/rate-cards/rate-cards.routes.js";
import { createRateCardsService } from "./modules/rate-cards/rate-cards.service.js";
import {
  createConfiguredSuggester,
  createFileMappingRouter,
  createMappingsRouter,
} from "./modules/mapping/mapping.routes.js";
import { createMappingService } from "./modules/mapping/mapping.service.js";
import { createIngestionRouter } from "./modules/ingestion/ingestion.routes.js";
import { createIngestionService } from "./modules/ingestion/ingestion.service.js";
import { createSourcesRouter } from "./modules/sources/sources.routes.js";
import { createSourcesService } from "./modules/sources/sources.service.js";
import { createUploadsRouter } from "./modules/uploads/uploads.routes.js";
import { createUploadsService } from "./modules/uploads/uploads.service.js";

export interface AppOptions {
  /** Failed sign-in attempts allowed per IP address in 15 minutes. Tests change this. */
  loginRateLimitMax?: number;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");

  app.use(requestLogger);
  app.use(helmet());
  app.use(cookieParser());
  app.use(express.json({ limit: "100kb" }));

  // Public: no sign-in needed.
  app.use("/api/health", healthRouter);

  // Sign-in, "who am I" and sign-out.
  const sessionTtlMs = env.SESSION_TTL_HOURS * 60 * 60 * 1000;
  const authService = createAuthService({
    prisma,
    bcryptCost: env.BCRYPT_COST,
    sessionTtlMs,
    maxFailedAttempts: env.LOGIN_MAX_FAILED_ATTEMPTS,
    lockMs: env.LOGIN_LOCK_MINUTES * 60 * 1000,
  });
  const { authenticate, csrfProtection } = createAuthMiddleware({ service: authService });
  app.use(
    "/api/auth",
    createAuthRouter({
      service: authService,
      authenticate,
      csrfProtection,
      loginRateLimiter: createLoginRateLimiter(
        options.loginRateLimitMax ?? env.LOGIN_RATE_LIMIT_MAX,
      ),
      sessionTtlMs,
    }),
  );

  // Everything below needs a valid session, and a CSRF token on requests that change data.
  // Each router also checks the role itself (finance executive only).
  const guards = [authenticate, csrfProtection];
  app.use(
    "/api/sources",
    createSourcesRouter({ service: createSourcesService({ prisma }), guards }),
  );
  const mappingService = createMappingService({ prisma, suggester: createConfiguredSuggester() });
  app.use("/api/uploads", createFileMappingRouter({ service: mappingService, guards }));
  app.use("/api/mappings", createMappingsRouter({ service: mappingService, guards }));
  app.use(
    "/api/uploads",
    createIngestionRouter({ service: createIngestionService({ prisma }), guards }),
  );
  app.use(
    "/api/uploads",
    createUploadsRouter({ service: createUploadsService({ prisma }), guards }),
  );

  // Rate cards: both roles can read (the co-founder's screen is view-only); only the finance
  // executive can create a card or make a new version. The router checks that itself.
  app.use(
    "/api/rate-cards",
    createRateCardsRouter({ service: createRateCardsService({ prisma }), guards }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
