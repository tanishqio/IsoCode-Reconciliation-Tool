import { prisma } from "../db/prisma.js";
import { createRecomputeHandler } from "../modules/reconciliation/recompute-handler.js";
import { createIngestHandler } from "../modules/ingestion/ingest-handler.js";
import type { JobHandlers } from "./job-types.js";

// One handler per job type. A queued job whose type has no handler fails with
// "No handler is registered for job type ...".
// Part 10 adds BUILD_CLAIMS.
export const jobHandlers: JobHandlers = {
  INGEST_FILE: createIngestHandler(prisma),
  RECOMPUTE_RESULTS: createRecomputeHandler(prisma),
};
