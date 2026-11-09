// TEMPORARY test routes for the Part 0 foundation. Remove this folder and its line in app.ts
// before Part 1 is merged or the project is submitted. Mounted only when NODE_ENV is not "production".
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/errors.js";

class Rollback extends Error {
  readonly result: unknown;
  constructor(result: unknown) {
    super("rollback");
    this.result = result;
  }
}

export const devRouter = Router();

// Database success path: SELECT 1, then write a user and a job inside a transaction,
// read the job back, and roll everything back so no data is left behind.
devRouter.get("/db-check", async (_req, res) => {
  const [select1] = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
  const usersBefore = await prisma.user.count();
  const jobsBefore = await prisma.processingJob.count();

  let inTransaction: unknown;
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: `dev-check-${randomUUID()}@example.invalid`,
          name: "Dev Check",
          passwordHash: "not-a-real-hash",
          role: "FINANCE_EXECUTIVE",
        },
      });
      const created = await tx.processingJob.create({
        data: { type: "INGEST_FILE", entityType: "DEV_CHECK", createdById: user.id },
      });
      const readBack = await tx.processingJob.findUniqueOrThrow({ where: { id: created.id } });
      throw new Rollback({
        jobStatus: readBack.status,
        progressPct: readBack.progressPct,
        attempt: readBack.attempt,
        queuedAtIsSet: readBack.queuedAt instanceof Date,
        userRole: user.role,
      });
    });
  } catch (err) {
    if (err instanceof Rollback) inTransaction = err.result;
    else throw err;
  }

  const usersAfter = await prisma.user.count();
  const jobsAfter = await prisma.processingJob.count();

  res.json({
    database: "up",
    select1: select1?.ok === 1,
    inTransaction,
    rolledBack: usersBefore === usersAfter && jobsBefore === jobsAfter,
    counts: { usersBefore, usersAfter, jobsBefore, jobsAfter },
  });
});

const bodySchema = z.object({
  name: z.string().min(2),
  amount: z.number().int().positive(),
});

// Triggers the Zod to 422 mapping.
devRouter.post("/validate", (req, res) => {
  const body = bodySchema.parse(req.body);
  res.json({ ok: true, body });
});

// Triggers an AppError (409 with details).
devRouter.get("/app-error", () => {
  throw new AppError("CONFLICT", 409, "This is a test conflict.", { field: "example" });
});

// Triggers an unexpected error: the response must be a generic 500 with no internal detail.
devRouter.get("/boom", () => {
  throw new Error("secret internal detail that must not reach the client");
});
