// Entry point of the background worker. Started separately from the API server:
//   npm run worker -w @leaklens/api      (or `npm run dev` at the repository root)
// It shares the database, configuration and code with the API, but not its process.
import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { jobHandlers } from "./jobs/handlers.js";
import { startWorker } from "./jobs/worker-loop.js";
import { logger } from "./lib/logger.js";

const STOP_GRACE_MS = 30_000;

const worker = startWorker({
  handlers: jobHandlers,
  logger,
  pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
  staleAfterMs: env.WORKER_STALE_AFTER_MS,
});

logger.info(
  {
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
    staleAfterMs: env.WORKER_STALE_AFTER_MS,
    handlers: Object.keys(jobHandlers),
  },
  "worker started",
);

function shutdown(signal: string) {
  logger.info({ signal }, "worker shutting down; finishing the current job if there is one");
  // If a job does not finish in time, leave it RUNNING. The next worker start fails it as stale.
  setTimeout(() => process.exit(1), STOP_GRACE_MS).unref();
  worker
    .stop()
    .catch((err: unknown) => logger.error({ err }, "error while stopping the worker"))
    .finally(() => {
      prisma
        .$disconnect()
        .catch((err: unknown) => logger.error({ err }, "error while disconnecting the database"))
        .finally(() => process.exit(0));
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection in the worker");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception in the worker");
  process.exit(1);
});
