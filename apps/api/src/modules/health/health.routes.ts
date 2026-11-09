import { Router } from "express";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/errors.js";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const healthRouter = Router();

// Liveness: the process is up. Does not touch the database.
healthRouter.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness: the database answers a trivial query within 2 seconds.
healthRouter.get("/ready", async (req, res) => {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 2000);
  } catch (err) {
    req.log.error({ err }, "database check failed");
    throw new AppError("DATABASE_UNAVAILABLE", 503, "The database is not reachable.");
  }
  res.json({ status: "ok", database: "up" });
});
