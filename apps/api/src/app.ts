import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { devRouter } from "./modules/dev/dev.routes.js";
import { healthRouter } from "./modules/health/health.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.use(requestLogger);
  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));

  app.use("/api/health", healthRouter);
  if (env.NODE_ENV !== "production") {
    app.use("/api/dev", devRouter); // TEMPORARY, see modules/dev/dev.routes.ts
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
