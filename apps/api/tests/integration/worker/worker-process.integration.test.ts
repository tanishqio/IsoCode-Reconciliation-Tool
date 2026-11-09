// Starts the real src/worker.ts as its own process (the way `npm run worker` does) and checks
// that it connects, takes a queued job and finishes it. No handler is registered yet, so the
// job must end FAILED with the "No handler" message. The process uses the test database only.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../src/db/prisma.js";
import { apiRoot, assertTestDatabase, getTestDatabaseUrl } from "../../helpers/test-db.js";

let child: ChildProcess | null = null;
let userId: string;

beforeAll(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "processing_jobs", "users" CASCADE');
  const user = await prisma.user.create({
    data: {
      email: `p-${randomUUID()}@example.invalid`,
      name: "P",
      passwordHash: "x",
      role: "FINANCE_EXECUTIVE",
    },
  });
  userId = user.id;
});

afterAll(async () => {
  if (child && child.exitCode === null) child.kill();
  await prisma.$disconnect();
});

describe("worker process (src/worker.ts)", () => {
  it("starts on its own, takes a queued job and finishes it", async () => {
    child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: getTestDatabaseUrl(),
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        WORKER_POLL_INTERVAL_MS: "100",
      },
      stdio: "ignore",
    });
    let exitedEarly: number | null = null;
    child.once("exit", (code) => (exitedEarly = code ?? -1));

    const queued = await prisma.processingJob.create({
      data: { type: "BUILD_CLAIMS", entityType: "CLAIM_RUN", createdById: userId },
    });

    const deadline = Date.now() + 45_000;
    for (;;) {
      const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: queued.id } });
      if (job.status === "FAILED") {
        expect(job.errorMessage).toBe("No handler is registered for job type BUILD_CLAIMS.");
        expect(job.attempt).toBe(1);
        expect(job.finishedAt).toBeInstanceOf(Date);
        break;
      }
      if (exitedEarly !== null)
        throw new Error(`the worker process exited early with code ${exitedEarly}`);
      if (Date.now() > deadline)
        throw new Error(`the worker never picked up the job (status ${job.status})`);
      await sleep(250);
    }
    expect(child.exitCode).toBeNull(); // still running after the job: it keeps polling
  }, 60_000);
});
