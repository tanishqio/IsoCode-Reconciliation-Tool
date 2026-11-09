import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Looks for secrets in the files that could be committed or shared. It prints where it found
// something and which rule matched, and never prints the secret itself.
//
// Two kinds of check:
//   1. The real secret values from this machine's .env files must appear in no other file. This is
//      the strongest check: a leaked password is found even if it looks like ordinary text.
//   2. A few well-known shapes (private keys, API keys of common providers, long bearer tokens).

export interface Finding {
  /** Path relative to the scanned folder, with forward slashes. */
  file: string;
  line: number;
  rule: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_FOLDERS = new Set([
  "node_modules",
  ".git",
  "dist",
  "generated",
  "coverage",
  ".bench-data",
  ".vite",
]);
const SECRET_KEY_NAME = /pass|secret|token|key|url|credential/i;

interface Pattern {
  rule: string;
  regex: RegExp;
}

// Written so this file does not match its own patterns.
const PATTERNS: Pattern[] = [
  { rule: "PRIVATE_KEY", regex: new RegExp("-----BEGIN (?:[A-Z]+ )?PRIVATE " + "KEY-----") },
  { rule: "OPENAI_STYLE_API_KEY", regex: /\bsk-[A-Za-z0-9_-]{24,}\b/ },
  { rule: "AWS_ACCESS_KEY_ID", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "LONG_BEARER_TOKEN", regex: /\bbearer\s+[A-Za-z0-9._~+/-]{32,}/i },
  { rule: "GITHUB_TOKEN", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
];

/** Values of secret-looking keys in the .env files of the project (never the example files). */
export function collectSecretValues(root: string): string[] {
  const values = new Set<string>();
  const candidates = [
    path.join(root, ".env"),
    path.join(root, "apps", "api", ".env"),
    path.join(root, "apps", "web", ".env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const equals = line.indexOf("=");
      if (equals < 1) continue;
      const key = line.slice(0, equals).trim();
      const value = line
        .slice(equals + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!SECRET_KEY_NAME.test(key) || value.length < 8) continue;
      values.add(value);
      // The password inside a connection string is a secret on its own.
      try {
        const password = decodeURIComponent(new URL(value).password);
        if (password.length >= 6) values.add(password);
      } catch {
        // not a URL
      }
    }
  }
  return [...values];
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 4096).includes(0);
}

/** Scans one file's text. Exported for tests. */
export function scanText(text: string, file: string, secretValues: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) findings.push({ file, line: index + 1, rule: pattern.rule });
    }
    for (const secret of secretValues) {
      if (line.includes(secret))
        findings.push({ file, line: index + 1, rule: "REAL_SECRET_VALUE" });
    }
  });
  return findings;
}

function walk(root: string, folder = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const relative = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_FOLDERS.has(entry.name)) out.push(...walk(root, relative));
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
  return out;
}

/** The files git would commit (tracked, or new and not ignored). Falls back to every file. */
export function listCandidateFiles(root: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const files = output.split("\0").filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // not a git repository
  }
  return walk(root);
}

export interface ScanOptions {
  /** Extra files or folders to scan even if git ignores them (for example docs/). */
  extra?: string[];
  /** Overrides the secret values read from the .env files. Tests use this. */
  secretValues?: string[];
}

export function scanRepo(root: string, options: ScanOptions = {}): Finding[] {
  const secretValues = options.secretValues ?? collectSecretValues(root);
  const files = new Set(listCandidateFiles(root));
  for (const extra of options.extra ?? []) {
    const full = path.join(root, extra);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(root, extra).forEach((file) => files.add(file));
    else files.add(extra);
  }

  const findings: Finding[] = [];
  for (const file of files) {
    const base = path.basename(file);
    // The real .env files are meant to hold secrets. Example files are scanned like any other.
    if (/^\.env(\..+)?$/.test(base) && base !== ".env.example") continue;
    if (file.split("/").some((part) => SKIP_FOLDERS.has(part))) continue;
    const full = path.join(root, file);
    let buffer: Buffer;
    try {
      if (statSync(full).size > MAX_FILE_BYTES) continue;
      buffer = readFileSync(full);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;
    findings.push(...scanText(buffer.toString("utf8"), file.replaceAll("\\", "/"), secretValues));
  }
  return findings;
}
