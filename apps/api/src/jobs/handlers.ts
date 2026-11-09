import { prisma } from "../db/prisma.js";
import { createIngestHandler } from "../modules/ingestion/ingest-handler.js";
import type { JobHandlers } from "./job-types.js";

// One handler per job type. A queued job whose type has no handler fails with
// "No handler is registered for job type ...".
// Part 5/6 add RECOMPUTE_RESULTS, Part 10 adds BUILD_CLAIMS.
export const jobHandlers: JobHandlers = {
  INGEST_FILE: createIngestHandler(prisma),
};
