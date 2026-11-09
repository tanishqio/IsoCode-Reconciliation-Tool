import { prisma } from "../db/prisma.js";
import { createBuildClaimsHandler } from "../modules/claims/build-handler.js";
import { createSuggestHandler } from "../modules/review/suggest-handler.js";
import { createRecomputeHandler } from "../modules/reconciliation/recompute-handler.js";
import { createIngestHandler } from "../modules/ingestion/ingest-handler.js";
import type { JobHandlers } from "./job-types.js";

// One handler per job type. A queued job whose type has no handler fails with
// "No handler is registered for job type ...".
export const jobHandlers: JobHandlers = {
  INGEST_FILE: createIngestHandler(prisma),
  RECOMPUTE_RESULTS: createRecomputeHandler(prisma),
  SUGGEST_MATCHES: createSuggestHandler(prisma),
  BUILD_CLAIMS: createBuildClaimsHandler(prisma),
};
