import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GeneratedDataset } from "./generate.js";

export interface Manifest {
  generatedBy: string;
  note: string;
  options: { orders: number; seed: number; startDate: string; days: number };
  /** "Today" for the due-date rules: the newest date in the files. */
  asOf: string;
  files: { name: string; source: string; fileType: string; rows: number }[];
  summary: Omit<GeneratedDataset["summary"], "tax"> & { taxLines: number };
}

/** Writes the CSV files, manifest.json (what each file is) and truth.json (what each order should be). */
export function writeDataset(dataset: GeneratedDataset, outDir: string): Manifest {
  mkdirSync(outDir, { recursive: true });
  for (const file of dataset.files) {
    writeFileSync(path.join(outDir, file.name), file.content, "utf8");
  }
  const { tax, ...summary } = dataset.summary;
  const manifest: Manifest = {
    generatedBy: "apps/api/scripts/generate-sample-data.ts",
    note: "Synthetic data for the demo. No real customers, partners or amounts.",
    options: {
      orders: dataset.options.orders,
      seed: dataset.options.seed,
      startDate: dataset.options.startDate,
      days: dataset.options.days,
    },
    asOf: dataset.asOf,
    files: dataset.files.map(({ name, source, fileType, rows }) => ({
      name,
      source,
      fileType,
      rows,
    })),
    summary: { ...summary, taxLines: tax.reduce((total, entry) => total + entry.lines, 0) },
  };
  writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(outDir, "truth.json"),
    `${JSON.stringify({ asOf: dataset.asOf, orders: dataset.truth, tax }, null, 1)}\n`,
    "utf8",
  );
  return manifest;
}
