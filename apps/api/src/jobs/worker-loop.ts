import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import {
  claimNextJob,
  failStaleJobs,
  markFailed,
  markSucceeded,
  touchHeartbeat,
  updateJobStage,
} from "./job-queue.js";
import { JobFailure, type ClaimedJob, type JobContext, type JobHandlers } from "./job-types.js";

export interface WorkerOptions {
  handlers: JobHandlers;
  logger: Logger;
  /** How long to wait before looking at the queue again when it was empty. */
  pollIntervalMs: number;
  /** How often a running job reports that it is still alive. */
  heartbeatIntervalMs: number;
  /** A RUNNING job with no heartbeat for this long, found at startup, is failed. */
  staleAfterMs: number;
}

export interface Worker {
  /** Stops taking new jobs and resolves after the job in progress (if any) has finished. */
  stop(): Promise<void>;
}

/** Adds up the time spent in each named stage of one job. */
class StageTimer {
  private current: { name: string; startedAt: number } | null = null;
  private readonly totals: Record<string, number> = {};

  start(name: string): void {
    this.close();
    this.current = { name, startedAt: performance.now() };
  }

  /** Stops timing and returns milliseconds per stage. */
  finish(): Record<string, number> {
    this.close();
    return { ...this.totals };
  }

  private close(): void {
    if (!this.current) return;
    const elapsed = Math.round(performance.now() - this.current.startedAt);
    this.totals[this.current.name] = (this.totals[this.current.name] ?? 0) + elapsed;
    this.current = null;
  }
}

/** The message saved on a failed job. Only JobFailure messages are passed through. */
function failureMessage(error: unknown, jobId: string): string {
  if (error instanceof JobFailure) return error.message;
  return `Unexpected error while processing. See the server log for job ${jobId}.`;
}

async function runJob(
  job: ClaimedJob,
  options: WorkerOptions,
  stopSignal: AbortSignal,
): Promise<void> {
  const log = options.logger.child({ jobId: job.id, jobType: job.type });
  const timer = new StageTimer();
  const startedAt = performance.now();
  log.info({ attempt: job.attempt }, "job started");

  const heartbeat = setInterval(() => {
    touchHeartbeat(job.id).catch((err: unknown) => log.warn({ err }, "could not send heartbeat"));
  }, options.heartbeatIntervalMs);

  try {
    const handler = options.handlers[job.type];
    if (!handler) throw new JobFailure(`No handler is registered for job type ${job.type}.`);

    const context: JobContext = {
      job,
      signal: stopSignal,
      setStage: async (stage, progressPct) => {
        timer.start(stage);
        await updateJobStage(job.id, stage, progressPct);
      },
    };
    await handler(context);

    await markSucceeded(job.id, timer.finish());
    log.info({ durationMs: Math.round(performance.now() - startedAt) }, "job succeeded");
  } catch (err) {
    if (err instanceof JobFailure) log.warn({ reason: err.message }, "job failed");
    else log.error({ err }, "job failed with an unexpected error");
    try {
      await markFailed(job.id, failureMessage(err, job.id), timer.finish());
    } catch (saveError) {
      log.error({ err: saveError }, "could not save the failure on the job");
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Starts the worker loop: fail stale jobs, then repeatedly take the oldest queued job and run
 * its handler, one job at a time. Waits `pollIntervalMs` when the queue is empty.
 */
export function startWorker(options: WorkerOptions): Worker {
  const stopController = new AbortController();
  const { signal } = stopController;

  const loop = (async () => {
    try {
      const failed = await failStaleJobs(options.staleAfterMs);
      if (failed > 0)
        options.logger.warn({ failed }, "failed jobs left running by a worker that stopped");
    } catch (err) {
      options.logger.error({ err }, "could not check for stale jobs");
    }

    while (!signal.aborted) {
      let job: ClaimedJob | null = null;
      try {
        job = await claimNextJob();
      } catch (err) {
        options.logger.error({ err }, "could not read the job queue; will try again");
      }

      if (job) {
        await runJob(job, options, signal);
        continue;
      }
      // Queue empty (or the database was unreachable): wait, but wake up straight away on stop.
      await sleep(options.pollIntervalMs, undefined, { signal }).catch(() => undefined);
    }
  })();

  return {
    stop: async () => {
      stopController.abort();
      await loop;
    },
  };
}
