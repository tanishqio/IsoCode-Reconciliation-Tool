import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./lib/logger.js";

const server = createApp().listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "API listening");
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(() => {
    prisma
      .$disconnect()
      .catch((err: unknown) => logger.error({ err }, "error while disconnecting the database"))
      .finally(() => process.exit(0));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  process.exit(1);
});
