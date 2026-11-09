import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSecretValues, scanRepo, scanText } from "../../../src/tools/secret-scan.js";
import { makeTempDir } from "../../helpers/part2-fixtures.js";

// Fake secrets, built from pieces so this test file is not itself a finding.
const FAKE_PRIVATE_KEY = ["-----BEGIN ", "RSA PRIVATE ", "KEY-----"].join("");
const FAKE_API_KEY = ["sk", "-", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
const FAKE_AWS_KEY = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
const FAKE_PASSWORD = "Zq7-fake-demo-password-93";

let root: string;

beforeEach(() => {
  root = makeTempDir("secret-scan");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string | Buffer) {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("scanText", () => {
  it("finds well-known secret shapes", () => {
    expect(scanText(`key = "${FAKE_API_KEY}"`, "a.ts", []).map((f) => f.rule)).toEqual([
      "OPENAI_STYLE_API_KEY",
    ]);
    expect(scanText(FAKE_PRIVATE_KEY, "a.pem", []).map((f) => f.rule)).toEqual(["PRIVATE_KEY"]);
    expect(scanText(`id: ${FAKE_AWS_KEY}`, "a.yml", []).map((f) => f.rule)).toEqual([
      "AWS_ACCESS_KEY_ID",
    ]);
    expect(
      scanText(`Authorization: Bearer ${"a".repeat(40)}`, "a.http", []).map((f) => f.rule),
    ).toEqual(["LONG_BEARER_TOKEN"]);
  });

  it("finds a real secret value and gives the line number, not the value", () => {
    const findings = scanText(`one\ntwo\npassword is ${FAKE_PASSWORD}\n`, "notes.md", [
      FAKE_PASSWORD,
    ]);
    expect(findings).toEqual([{ file: "notes.md", line: 3, rule: "REAL_SECRET_VALUE" }]);
    expect(JSON.stringify(findings)).not.toContain(FAKE_PASSWORD);
  });

  it("leaves ordinary text and placeholders alone", () => {
    const text = [
      "DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/DATABASE",
      "const key = 'short';",
      "Authorization: Bearer <token>",
      "skip-this-sk-word and sk-short",
    ].join("\n");
    expect(scanText(text, "a.md", [])).toEqual([]);
  });
});

describe("collectSecretValues", () => {
  it("reads secret-looking values from the .env files, and the password inside a database URL", () => {
    write(
      "apps/api/.env",
      [
        "# comment",
        "PORT=4000",
        `SEED_EXECUTIVE_PASSWORD=${FAKE_PASSWORD}`,
        "AI_API_KEY=short",
        'DATABASE_URL="postgresql://app:dbpass-9876543@localhost:5433/app"',
        "LOG_LEVEL=information-level",
      ].join("\n"),
    );
    const values = collectSecretValues(root);
    expect(values).toContain(FAKE_PASSWORD);
    expect(values).toContain("dbpass-9876543");
    expect(values).not.toContain("4000");
    expect(values).not.toContain("short");
    expect(values).not.toContain("information-level");
  });

  it("returns nothing when there is no .env", () => {
    expect(collectSecretValues(root)).toEqual([]);
  });
});

describe("scanRepo", () => {
  it("finds a real password that was pasted into another file", () => {
    write("apps/api/.env", `SEED_EXECUTIVE_PASSWORD=${FAKE_PASSWORD}\n`);
    write("README.md", "# Project\nLogin with the password above\n");
    write("docs/notes.md", `demo password: ${FAKE_PASSWORD}\n`);
    const findings = scanRepo(root);
    expect(findings).toEqual([{ file: "docs/notes.md", line: 1, rule: "REAL_SECRET_VALUE" }]);
  });

  it("does not flag the .env files themselves, but does flag .env.example", () => {
    write(".env", `DB_PASSWORD=${FAKE_PASSWORD}\n`);
    write("apps/api/.env", `SEED_EXECUTIVE_PASSWORD=${FAKE_PASSWORD}\n`);
    write("apps/api/.env.example", `SEED_EXECUTIVE_PASSWORD=${FAKE_PASSWORD}\n`);
    expect(scanRepo(root).map((finding) => finding.file)).toEqual(["apps/api/.env.example"]);
  });

  it("skips node_modules, build output, generated code and binary files", () => {
    write("node_modules/pkg/index.js", `x = "${FAKE_API_KEY}"`);
    write("dist/app.js", `x = "${FAKE_API_KEY}"`);
    write("apps/api/generated/prisma/client.ts", `x = "${FAKE_API_KEY}"`);
    write("logo.bin", Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(FAKE_API_KEY)]));
    expect(scanRepo(root)).toEqual([]);
  });

  it("scans an extra folder that git would ignore", () => {
    write("src/a.ts", "const a = 1;\n");
    write("docs/private.md", `key ${FAKE_API_KEY}\n`);
    expect(scanRepo(root, { extra: ["docs"] }).map((finding) => finding.file)).toContain(
      "docs/private.md",
    );
  });

  it("reports every file and line, with forward slashes", () => {
    write("a/b/one.ts", `1\nx = "${FAKE_API_KEY}"\n`);
    write("a/two.ts", `${FAKE_PRIVATE_KEY}\n`);
    expect(scanRepo(root).sort((x, y) => x.file.localeCompare(y.file))).toEqual([
      { file: "a/b/one.ts", line: 2, rule: "OPENAI_STYLE_API_KEY" },
      { file: "a/two.ts", line: 1, rule: "PRIVATE_KEY" },
    ]);
  });

  it("finds nothing in a clean project", () => {
    write("src/a.ts", "export const a = 1;\n");
    write("apps/api/.env", `SEED_EXECUTIVE_PASSWORD=${FAKE_PASSWORD}\n`);
    expect(scanRepo(root)).toEqual([]);
  });
});

describe("this repository", () => {
  it("has no secrets in the files that could be committed or shared", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const findings = scanRepo(repoRoot, {
      extra: ["docs", "AGENTS.md", "CLAUDE.md", "README.md"],
    });
    expect(findings).toEqual([]);
  });
});
