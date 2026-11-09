// Builds consistent, synthetic sample files for all five report types.
//
//   npx tsx scripts/generate-sample-data.ts --orders 400 --seed 2026 --out ../../sample-data/demo
//   npx tsx scripts/generate-sample-data.ts --orders 100000 --out ../../.bench-data/orders-100000
//
// Writes one CSV per source and report type, manifest.json (which source and type each file is for)
// and truth.json (what every order should end up as). The same seed always gives the same files.
import path from "node:path";
import { generateDataset } from "../src/tools/sample-data/generate.js";
import { writeDataset } from "../src/tools/sample-data/write.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const orders = Number(argument("orders") ?? "400");
const seed = Number(argument("seed") ?? "2026");
const out = argument("out");

if (!Number.isInteger(orders) || orders < 1 || !Number.isInteger(seed) || !out) {
  console.error(
    "Usage: tsx scripts/generate-sample-data.ts --orders <number> [--seed <number>] --out <folder>",
  );
  process.exit(1);
}

const startedAt = performance.now();
const dataset = generateDataset({ orders, seed });
const manifest = writeDataset(dataset, path.resolve(out));
const ms = Math.round(performance.now() - startedAt);

console.log(
  `Wrote ${manifest.files.length} files for ${manifest.summary.orders} orders to ${path.resolve(out)} in ${ms} ms.`,
);
console.log(`Data runs up to ${manifest.asOf.slice(0, 10)}.`);
console.log("What each order should end up as:");
for (const [status, count] of Object.entries(manifest.summary.byStatus).sort()) {
  console.log(`  ${status.padEnd(22)} ${count}`);
}
console.log(
  `Payment lines that cannot be matched: ${manifest.summary.orphanLines}. Settlement rows written twice: ${manifest.summary.duplicateRows}.`,
);
