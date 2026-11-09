// Loads the sample files into a running LeakLens API, the way a person would.
//
//   npm run demo:load                          (API on http://localhost:4000, folder ../../sample-data/demo)
//   npm run demo:load -- --dir ../../.bench-data/orders-1000 --api http://localhost:4000
//
// Needs the whole stack running (npm run dev starts the API, the worker and the web app) and the
// seed done (npm run db:seed). Signs in with SEED_EXECUTIVE_EMAIL and SEED_EXECUTIVE_PASSWORD from
// apps/api/.env. Running it twice is safe: files that are already there are reported as duplicates.
import "dotenv/config";
import path from "node:path";
import { loadDemoData } from "../src/tools/sample-data/load-demo.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const email = process.env["SEED_EXECUTIVE_EMAIL"];
const password = process.env["SEED_EXECUTIVE_PASSWORD"];
if (!email || !password) {
  console.error("SEED_EXECUTIVE_EMAIL and SEED_EXECUTIVE_PASSWORD must be set in apps/api/.env.");
  process.exit(1);
}

const dir = path.resolve(argument("dir") ?? path.join("..", "..", "sample-data", "demo"));
const baseUrl = argument("api") ?? `http://localhost:${process.env["PORT"] ?? "4000"}`;

try {
  const result = await loadDemoData({
    baseUrl,
    email,
    password,
    dir,
    log: (message) => console.log(message),
  });
  console.log("");
  console.log(`Files in the folder:      ${result.files}`);
  console.log(`Uploaded now:             ${result.uploaded}`);
  console.log(`Already there (skipped):  ${result.alreadyThere}`);
  console.log(`Column mappings approved: ${result.mappingsApproved}`);
  if (result.refused.length > 0) {
    console.log("Refused:");
    for (const item of result.refused) console.log(`  ${item.file}: ${item.reason}`);
  }
  if (result.needsAttention.length > 0) {
    console.log("Waiting for a person on the Uploads screen:");
    for (const item of result.needsAttention) console.log(`  ${item.file}: ${item.reason}`);
  }
  const rejectedRows = result.finished.reduce((total, file) => total + (file.rejected ?? 0), 0);
  console.log(`Rows rejected while reading: ${rejectedRows}`);
  if (result.calculation) console.log(`Order results calculated: ${result.calculation.orderCount}`);
  console.log("Open the app: Money at risk shows the result.");
} catch (err) {
  console.error(err instanceof Error ? err.message : "Loading the sample data failed.");
  process.exit(1);
}
