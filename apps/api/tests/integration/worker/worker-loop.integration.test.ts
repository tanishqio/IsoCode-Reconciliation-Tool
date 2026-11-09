import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../../src/db/prisma.js";
import { JobFailure, type JobHandlers } from "../../../src/jobs/job-types.js";
import { startWorker, type Worker } from "../../../src/jobs/worker-loop.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const silent = pino({ level: "silent" });
let userId: string;
let running: Worker | null = null;

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "processing_jobs", "users" CASCADE');
  const user = await prisma.user.create({
    data: {
      email: `l-${randomUUID()}@example.invalid`,
      name: "L",
      passwordHash: "x",
      role: "FINANCE_EXECUTIVE",
    },
  });
  userId = user.id;
});

afterEach(async () => {
  await running?.stop();
  running = null;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function start(handlers: JobHandlers, overrides: Partial<Parameters<typeof startWorker>[0]> = {}) {
  running = startWorker({
    handlers,
    logger: silent,
    pollIntervalMs: 30,
    heartbeatIntervalMs: 100,
    staleAfterMs: 60_000,
    ...overrides,
  });
  return running;
}

type JobType = "INGEST_FILE" | "RECOMPUTE_RESULTS" | "BUILD_CLAIMS";
const queueJob = (
  type: JobType = "INGEST_FILE",
  extra: { params?: object; entityId?: string } = {},
) =>
  prisma.processingJob.create({
    data: { type, entityType: "UPLOADED_FILE", createdById: userId, ...extra },
  });

async function waitForStatus(id: string, statuses: string[], timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id } });
    if (statuses.includes(job.status)) return job;
    if (Date.now() > deadline)
      throw new Error(`job ${id} is still ${job.status}, wanted ${statuses.join("/")}`);
    await sleep(25);
  }
}

describe("worker loop: running jobs", () => {
  it("runs a queued job to SUCCEEDED, passes the job data to the handler and records stage timings", async () => {
    const entityId = randomUUID();
    const seen: unknown[] = [];
    start({
      INGEST_FILE: async (context) => {
        seen.push({ ...context.job, signalAborted: context.signal.aborted });
        await context.setStage("READ", 20);
        await sleep(30);
        await context.setStage("MATCH", 70);
        await sleep(30);
      },
    });
    const queued = await queueJob("INGEST_FILE", { entityId, params: { rateCardVersion: 2 } });

    const done = await waitForStatus(queued.id, ["SUCCEEDED", "FAILED"]);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.progressPct).toBe(100);
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.attempt).toBe(1);
    expect(done.stage).toBe("MATCH");
    const timings = done.stageTimingsMs as Record<string, number>;
    expect(Object.keys(timings).sort()).toEqual(["MATCH", "READ"]);
    expect(timings["READ"]).toBeGreaterThanOrEqual(20);
    expect(timings["MATCH"]).toBeGreaterThanOrEqual(20);
    expect(seen).toEqual([
      expect.objectContaining({
        id: queued.id,
        entityId,
        params: { rateCardVersion: 2 },
        signalAborted: false,
      }),
    ]);
  });

  it("shows progress while the job runs", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    start({
      INGEST_FILE: async (context) => {
        await context.setStage("VALIDATE", 45);
        await gate;
      },
    });
    const queued = await queueJob();

    const deadline = Date.now() + 10_000;
    for (;;) {
      const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: queued.id } });
      if (job.status === "RUNNING" && job.stage === "VALIDATE") {
        expect(job.progressPct).toBe(45);
        break;
      }
      if (Date.now() > deadline) throw new Error("never saw the job running");
      await sleep(25);
    }
    release();
    expect((await waitForStatus(queued.id, ["SUCCEEDED"])).progressPct).toBe(100);
  });

  it("runs jobs one at a time, oldest first", async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    start({
      INGEST_FILE: async (context) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(context.job.id);
        await sleep(40);
        concurrent--;
      },
    });
    const first = await queueJob();
    await sleep(15);
    const second = await queueJob();
    await sleep(15);
    const third = await queueJob();

    await waitForStatus(third.id, ["SUCCEEDED"]);
    expect(order).toEqual([first.id, second.id, third.id]);
    expect(maxConcurrent).toBe(1);
  });

  it("picks up a job that is queued after the worker has been idle", async () => {
    start({ INGEST_FILE: async () => undefined });
    await sleep(150); // several empty polls
    const queued = await queueJob();
    expect((await waitForStatus(queued.id, ["SUCCEEDED"])).status).toBe("SUCCEEDED");
  });

  it("keeps the heartbeat moving while a long job runs", async () => {
    start({ INGEST_FILE: async () => void (await sleep(450)) }, { heartbeatIntervalMs: 100 });
    const queued = await queueJob();

    await waitForStatus(queued.id, ["RUNNING"]);
    const first = (await prisma.processingJob.findUniqueOrThrow({ where: { id: queued.id } }))
      .heartbeatAt!;
    await sleep(300);
    const later = (await prisma.processingJob.findUniqueOrThrow({ where: { id: queued.id } }))
      .heartbeatAt!;
    expect(later.getTime()).toBeGreaterThan(first.getTime());
  });
});

describe("worker loop: failures", () => {
  it("fails a job whose type has no handler, with a clear message", async () => {
    start({});
    const queued = await queueJob("BUILD_CLAIMS");
    const done = await waitForStatus(queued.id, ["SUCCEEDED", "FAILED"]);
    expect(done.status).toBe("FAILED");
    expect(done.errorMessage).toBe("No handler is registered for job type BUILD_CLAIMS.");
    expect(done.finishedAt).toBeInstanceOf(Date);
  });

  it("saves the message of a JobFailure, which is safe to show", async () => {
    start({
      INGEST_FILE: async () => {
        throw new JobFailure("The file is empty.");
      },
    });
    const queued = await queueJob();
    const done = await waitForStatus(queued.id, ["SUCCEEDED", "FAILED"]);
    expect(done.status).toBe("FAILED");
    expect(done.errorMessage).toBe("The file is empty.");
  });

  it("hides the message of an unexpected error, because it could hold personal data", async () => {
    start({
      INGEST_FILE: async () => {
        throw new Error("row 12: phone 9999999999 for Asha Rao is invalid");
      },
    });
    const queued = await queueJob();
    const done = await waitForStatus(queued.id, ["SUCCEEDED", "FAILED"]);
    expect(done.status).toBe("FAILED");
    expect(done.errorMessage).not.toContain("9999999999");
    expect(done.errorMessage).not.toContain("Asha");
    expect(done.errorMessage).toContain(queued.id);
  });

  it("still saves the stage timings of the stages that ran before the failure", async () => {
    start({
      INGEST_FILE: async (context) => {
        await context.setStage("READ", 10);
        await sleep(25);
        throw new JobFailure("Broke after reading.");
      },
    });
    const queued = await queueJob();
    const done = await waitForStatus(queued.id, ["FAILED"]);
    expect(Object.keys(done.stageTimingsMs as object)).toEqual(["READ"]);
  });

  it("keeps going after a failure: the next job still runs", async () => {
    let calls = 0;
    start({
      INGEST_FILE: async () => {
        calls++;
        if (calls === 1) throw new JobFailure("First one fails.");
      },
    });
    const first = await queueJob();
    await sleep(15);
    const second = await queueJob();
    expect((await waitForStatus(first.id, ["FAILED"])).status).toBe("FAILED");
    expect((await waitForStatus(second.id, ["SUCCEEDED"])).status).toBe("SUCCEEDED");
  });
});

describe("worker loop: start and stop", () => {
  it("fails jobs left RUNNING by a worker that died, when it starts", async () => {
    const stale = await prisma.processingJob.create({
      data: {
        type: "INGEST_FILE",
        entityType: "UPLOADED_FILE",
        createdById: userId,
        status: "RUNNING",
        startedAt: new Date(Date.now() - 600_000),
        heartbeatAt: new Date(Date.now() - 600_000),
      },
    });
    start({}, { staleAfterMs: 60_000 });
    const done = await waitForStatus(stale.id, ["FAILED"]);
    expect(done.errorMessage).toContain("worker stopped");
  });

  it("does not touch a RUNNING job that is still alive", async () => {
    const alive = await prisma.processingJob.create({
      data: {
        type: "INGEST_FILE",
        entityType: "UPLOADED_FILE",
        createdById: userId,
        status: "RUNNING",
        startedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
    start({});
    await sleep(200);
    expect((await prisma.processingJob.findUniqueOrThrow({ where: { id: alive.id } })).status).toBe(
      "RUNNING",
    );
  });

  it("stop() lets the current job finish and does not start the next one", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const worker = start({
      INGEST_FILE: async (context) => {
        await context.setStage("READ", 10);
        await gate;
      },
    });
    const first = await queueJob();
    await sleep(15);
    const second = await queueJob();
    await waitForStatus(first.id, ["RUNNING"]);

    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await sleep(150);
    expect(stopped).toBe(false); // still waiting for the running job

    release();
    await stopping;
    expect((await prisma.processingJob.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      "SUCCEEDED",
    );
    expect(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: second.id } })).status,
    ).toBe("QUEUED");
  });

  it("stop() returns quickly when the worker is idle", async () => {
    const worker = start({}, { pollIntervalMs: 5_000 });
    await sleep(50);
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("the handler sees the stop request through its signal", async () => {
    let aborted = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const worker = start({
      INGEST_FILE: async (context) => {
        await gate;
        aborted = context.signal.aborted;
      },
    });
    const queued = await queueJob();
    await waitForStatus(queued.id, ["RUNNING"]);
    const stopping = worker.stop();
    release();
    await stopping;
    expect(aborted).toBe(true);
  });
});
