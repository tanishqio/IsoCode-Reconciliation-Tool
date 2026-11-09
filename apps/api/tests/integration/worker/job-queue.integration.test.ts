import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../../src/db/prisma.js";
import {
  claimNextJob,
  failStaleJobs,
  markFailed,
  markSucceeded,
  touchHeartbeat,
  updateJobStage,
} from "../../../src/jobs/job-queue.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

let userId: string;

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]); // never empty tables outside the test database
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "processing_jobs", "users" CASCADE');
  const user = await prisma.user.create({
    data: {
      email: `w-${randomUUID()}@example.invalid`,
      name: "W",
      passwordHash: "x",
      role: "FINANCE_EXECUTIVE",
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

type Seed = {
  status?: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  queuedAt?: Date;
  heartbeatAt?: Date | null;
  startedAt?: Date | null;
  entityId?: string;
  params?: object;
};

function seedJob(seed: Seed = {}) {
  return prisma.processingJob.create({
    data: {
      type: "INGEST_FILE",
      entityType: "UPLOADED_FILE",
      entityId: seed.entityId,
      params: seed.params,
      status: seed.status ?? "QUEUED",
      queuedAt: seed.queuedAt,
      heartbeatAt: seed.heartbeatAt,
      startedAt: seed.startedAt,
      createdById: userId,
    },
  });
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const row = (id: string) => prisma.processingJob.findUniqueOrThrow({ where: { id } });

describe("claimNextJob", () => {
  it("returns null when the queue is empty", async () => {
    expect(await claimNextJob()).toBeNull();
  });

  it("takes a queued job, marks it RUNNING and returns what the handler needs", async () => {
    const entityId = randomUUID();
    const queued = await seedJob({ entityId, params: { rateCardVersion: 3 } });
    const claimed = await claimNextJob();

    expect(claimed).toMatchObject({
      id: queued.id,
      type: "INGEST_FILE",
      entityType: "UPLOADED_FILE",
      entityId,
      params: { rateCardVersion: 3 },
      attempt: 1,
      createdById: userId,
    });
    const saved = await row(queued.id);
    expect(saved.status).toBe("RUNNING");
    expect(saved.progressPct).toBe(0);
    expect(saved.startedAt).toBeInstanceOf(Date);
    expect(saved.heartbeatAt).toBeInstanceOf(Date);
  });

  it("writes timestamps in UTC, the same way Prisma does", async () => {
    await seedJob();
    const before = Date.now();
    const claimed = await claimNextJob();
    const saved = await row(claimed!.id);
    expect(Math.abs(saved.startedAt!.getTime() - before)).toBeLessThan(5_000);
    expect(Math.abs(saved.heartbeatAt!.getTime() - before)).toBeLessThan(5_000);
  });

  it("takes the oldest queued job first", async () => {
    const newest = await seedJob({ queuedAt: minutesAgo(1) });
    const oldest = await seedJob({ queuedAt: minutesAgo(30) });
    const middle = await seedJob({ queuedAt: minutesAgo(10) });
    expect((await claimNextJob())!.id).toBe(oldest.id);
    expect((await claimNextJob())!.id).toBe(middle.id);
    expect((await claimNextJob())!.id).toBe(newest.id);
    expect(await claimNextJob()).toBeNull();
  });

  it("ignores jobs that are already RUNNING, SUCCEEDED or FAILED", async () => {
    await seedJob({ status: "RUNNING" });
    await seedJob({ status: "SUCCEEDED" });
    await seedJob({ status: "FAILED" });
    expect(await claimNextJob()).toBeNull();
  });

  it("gives every job to exactly one worker when several ask at the same moment", async () => {
    const seeded = await Promise.all([seedJob(), seedJob(), seedJob()]);
    const results = await Promise.all(Array.from({ length: 8 }, () => claimNextJob()));

    const claimedIds = results.filter((job) => job !== null).map((job) => job!.id);
    expect(claimedIds).toHaveLength(3);
    expect(new Set(claimedIds).size).toBe(3);
    expect([...claimedIds].sort()).toEqual(seeded.map((job) => job.id).sort());
    expect(results.filter((job) => job === null)).toHaveLength(5);
  });

  it("clears the result of an earlier run and counts the attempt", async () => {
    const job = await seedJob();
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        attempt: 1,
        stage: "MATCH",
        progressPct: 80,
        errorMessage: "old",
        stageTimingsMs: { a: 1 },
      },
    });
    const claimed = await claimNextJob();
    expect(claimed!.attempt).toBe(2);
    const saved = await row(job.id);
    expect(saved.stage).toBeNull();
    expect(saved.progressPct).toBe(0);
    expect(saved.errorMessage).toBeNull();
    expect(saved.stageTimingsMs).toBeNull();
  });
});

describe("updates while a job runs", () => {
  it("updateJobStage saves the stage, a clamped progress value and a heartbeat", async () => {
    const job = await seedJob({ status: "RUNNING", heartbeatAt: minutesAgo(5) });
    expect(await updateJobStage(job.id, "READ", 40)).toBe(true);
    let saved = await row(job.id);
    expect(saved.stage).toBe("READ");
    expect(saved.progressPct).toBe(40);
    expect(Date.now() - saved.heartbeatAt!.getTime()).toBeLessThan(5_000);

    await updateJobStage(job.id, "MATCH", 250);
    saved = await row(job.id);
    expect(saved.progressPct).toBe(100);
    await updateJobStage(job.id, "MATCH", -5);
    expect((await row(job.id)).progressPct).toBe(0);
    await updateJobStage(job.id, "CLAIMS"); // no progress given: keeps the last value
    expect((await row(job.id)).progressPct).toBe(0);
  });

  it("touchHeartbeat moves the heartbeat forward", async () => {
    const job = await seedJob({ status: "RUNNING", heartbeatAt: minutesAgo(5) });
    expect(await touchHeartbeat(job.id)).toBe(true);
    expect(Date.now() - (await row(job.id)).heartbeatAt!.getTime()).toBeLessThan(5_000);
  });

  it("markSucceeded sets SUCCEEDED, 100 percent, a finish time and the stage timings", async () => {
    const job = await seedJob({ status: "RUNNING" });
    expect(await markSucceeded(job.id, { read: 900, match: 1100 })).toBe(true);
    const saved = await row(job.id);
    expect(saved.status).toBe("SUCCEEDED");
    expect(saved.progressPct).toBe(100);
    expect(saved.finishedAt).toBeInstanceOf(Date);
    expect(saved.stageTimingsMs).toEqual({ read: 900, match: 1100 });
  });

  it("markFailed sets FAILED with a message cut to 500 characters", async () => {
    const job = await seedJob({ status: "RUNNING" });
    expect(await markFailed(job.id, "x".repeat(900), { read: 5 })).toBe(true);
    const saved = await row(job.id);
    expect(saved.status).toBe("FAILED");
    expect(saved.errorMessage).toHaveLength(500);
    expect(saved.finishedAt).toBeInstanceOf(Date);
    expect(saved.stageTimingsMs).toEqual({ read: 5 });
  });

  it("never brings a finished job back to life", async () => {
    const failed = await seedJob({ status: "FAILED" });
    const done = await seedJob({ status: "SUCCEEDED" });
    for (const job of [failed, done]) {
      expect(await touchHeartbeat(job.id)).toBe(false);
      expect(await updateJobStage(job.id, "READ", 10)).toBe(false);
      expect(await markSucceeded(job.id, {})).toBe(false);
      expect(await markFailed(job.id, "late")).toBe(false);
    }
    expect((await row(failed.id)).status).toBe("FAILED");
    expect((await row(done.id)).status).toBe("SUCCEEDED");
  });
});

describe("failStaleJobs", () => {
  it("fails RUNNING jobs whose heartbeat is too old, with a clear message", async () => {
    const stale = await seedJob({
      status: "RUNNING",
      heartbeatAt: minutesAgo(10),
      startedAt: minutesAgo(11),
    });
    expect(await failStaleJobs(60_000)).toBe(1);
    const saved = await row(stale.id);
    expect(saved.status).toBe("FAILED");
    expect(saved.errorMessage).toContain("worker stopped");
    expect(saved.finishedAt).toBeInstanceOf(Date);
  });

  it("fails a RUNNING job that never sent a heartbeat and started long ago", async () => {
    const stale = await seedJob({
      status: "RUNNING",
      heartbeatAt: null,
      startedAt: minutesAgo(10),
    });
    expect(await failStaleJobs(60_000)).toBe(1);
    expect((await row(stale.id)).status).toBe("FAILED");
  });

  it("leaves a RUNNING job with a recent heartbeat alone", async () => {
    const alive = await seedJob({
      status: "RUNNING",
      heartbeatAt: new Date(),
      startedAt: minutesAgo(10),
    });
    expect(await failStaleJobs(60_000)).toBe(0);
    expect((await row(alive.id)).status).toBe("RUNNING");
  });

  it("leaves QUEUED, SUCCEEDED and FAILED jobs alone", async () => {
    await seedJob({ status: "QUEUED", queuedAt: minutesAgo(60) });
    await seedJob({ status: "SUCCEEDED", heartbeatAt: minutesAgo(60) });
    await seedJob({ status: "FAILED", heartbeatAt: minutesAgo(60) });
    expect(await failStaleJobs(60_000)).toBe(0);
    expect(await prisma.processingJob.count({ where: { status: "QUEUED" } })).toBe(1);
  });
});
