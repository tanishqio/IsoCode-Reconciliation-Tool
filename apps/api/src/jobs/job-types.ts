import type { JobType } from "../../generated/prisma/enums.js";

/** A job the worker has taken from the queue. */
export interface ClaimedJob {
  id: string;
  type: JobType;
  entityType: string;
  entityId: string | null;
  params: unknown;
  /** How many times this job has been started, including this run. */
  attempt: number;
  createdById: string;
}

export interface JobContext {
  job: ClaimedJob;
  /** Aborts when the worker is asked to stop. Long handlers should check it between steps. */
  signal: AbortSignal;
  /**
   * Records the stage the job is in (and optionally a progress percentage, 0 to 100).
   * The time spent in each stage is saved on the job as stageTimingsMs.
   */
  setStage(stage: string, progressPct?: number): Promise<void>;
}

export type JobHandler = (context: JobContext) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

/**
 * Throw this from a handler when the failure has a message that is safe to show to the user,
 * for example "The file is empty". Any other error is hidden behind a generic message,
 * because it could contain file contents or personal data.
 */
export class JobFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobFailure";
  }
}
