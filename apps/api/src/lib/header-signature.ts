import { createHash } from "node:crypto";

export function normaliseHeader(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function buildHeaderSignature(headers: readonly string[]): string {
  const normalised = headers.map(normaliseHeader).filter((name) => name.length > 0);
  normalised.sort();
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex");
}
