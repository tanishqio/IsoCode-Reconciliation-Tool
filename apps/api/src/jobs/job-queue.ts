import { prisma } from "../db/prisma.js";
import type { ClaimedJob } from "./job-types.js";

const MAX_MESSAGE_LENGTH = 500;
const STALE_MESSAGE = "The worker stopped while this job was running. Start the work again.";

/**
 * Takes the oldest QUEUED job and marks it RUNNING, in one statement.
 * FOR UPDATE SKIP LOCKED means that if two workers ask at the same moment, each gets a
 * different job, and nobody waits. Returns null when the queue is empty.
 *
 * Timestamps are written with now() AT TIME ZONE 'UTC' because these columns hold UTC time
 * without a time zone, which is how Prisma writes them.
 */
export async function claimNextJob(): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE processing_jobs
    SET status = 'RUNNING'::"JobStatus",
        "startedAt" = now() AT TIME ZONE 'UTC',
        "heartbeatAt" = now() AT TIME ZONE 'UTC',
        "finishedAt" = NULL,
        "errorMessage" = NULL,
        "stageTimingsMs" = NULL,
        stage = NULL,
        "progressPct" = 0,
        attempt = attempt + 1
    WHERE id = (
      SELECT id FROM processing_jobs
      WHERE status = 'QUEUED'::"JobStatus"
      ORDER BY "queuedAt" ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, type, "entityType", "entityId", params, attempt, "createdById"`;
  return rows[0] ?? null;
}

// The functions below only change a job that is still RUNNING. A job that was already
// failed (for example by the stale check) is never brought back to life by a late update.

export async function touchHeartbeat(jobId: string): Promise<boolean> {
  const result = await prisma.processingJob.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: { heartbeatAt: new Date() },
  });
  return result.count === 1;
}

export async function updateJobStage(
  jobId: string,
  stage: string,
  progressPct?: number,
): Promise<boolean> {
  const result = await prisma.processingJob.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: {
      stage,
      heartbeatAt: new Date(),
      ...(progressPct === undefined ? {} : { progressPct: clampPercent(progressPct) }),
    },
  });
  return result.count === 1;
}

export async function markSucceeded(
  jobId: string,
  stageTimingsMs: Record<string, number>,
): Promise<boolean> {
  const result = await prisma.processingJob.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: { status: "SUCCEEDED", progressPct: 100, finishedAt: new Date(), stageTimingsMs },
  });
  return result.count === 1;
}

export async function markFailed(
  jobId: string,
  message: string,
  stageTimingsMs?: Record<string, number>,
): Promise<boolean> {
  const result = await prisma.processingJob.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorMessage: message.slice(0, MAX_MESSAGE_LENGTH),
      ...(stageTimingsMs ? { stageTimingsMs } : {}),
    },
  });
  return result.count === 1;
}

/**
 * Fails jobs that say RUNNING but have not sent a heartbeat for a while. This happens when a
 * worker crashed or was killed mid-job. Run it when the worker starts.
 * Returns how many jobs were failed.
 */
export async function failStaleJobs(staleAfterMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const result = await prisma.processingJob.updateMany({
    where: {
      status: "RUNNING",
      OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
    },
    data: { status: "FAILED", finishedAt: new Date(), errorMessage: STALE_MESSAGE },
  });
  return result.count;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
