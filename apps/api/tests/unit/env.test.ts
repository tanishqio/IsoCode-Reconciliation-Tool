import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const MANAGED_KEYS = [
  "NODE_ENV",
  "PORT",
  "LOG_LEVEL",
  "DATABASE_URL",
  "UPLOAD_DIR",
  "UPLOAD_TEMP_DIR",
  "MAX_UPLOAD_FILE_BYTES",
  "MAX_UPLOAD_FILES",
];
const VALID_URL = "postgresql://user:pw@localhost:5433/db";

let errorOutput: string[] = [];

beforeEach(() => {
  vi.resetModules();
  // Stop dotenv from loading apps/api/.env, so the test controls every variable.
  vi.doMock("dotenv/config", () => ({}));
  errorOutput = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorOutput.push(args.join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("dotenv/config");
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function loadWith(vars: Record<string, string>) {
  for (const key of MANAGED_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  return import("../../src/config/env.js");
}

describe("environment validation: valid input", () => {
  it("applies defaults when only DATABASE_URL is given", async () => {
    const { env } = await loadWith({ DATABASE_URL: VALID_URL });
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATABASE_URL).toBe(VALID_URL);
  });

  it("converts PORT from text to a number", async () => {
    const { env } = await loadWith({ DATABASE_URL: VALID_URL, PORT: "5000" });
    expect(env.PORT).toBe(5000);
  });

  it.each(["postgresql://u:p@h:5432/db", "postgres://u:p@h:5432/db"])("accepts %s", async (url) => {
    const { env } = await loadWith({ DATABASE_URL: url });
    expect(env.DATABASE_URL).toBe(url);
  });

  it.each(["development", "test", "production"])("accepts NODE_ENV=%s", async (value) => {
    const { env } = await loadWith({ DATABASE_URL: VALID_URL, NODE_ENV: value });
    expect(env.NODE_ENV).toBe(value);
  });

  it("uses the agreed upload defaults: 5 files per request, 50 MB per file, absolute folders", async () => {
    const { env } = await loadWith({ DATABASE_URL: VALID_URL });
    expect(env.MAX_UPLOAD_FILES).toBe(5);
    expect(env.MAX_UPLOAD_FILE_BYTES).toBe(50 * 1024 * 1024);
    expect(path.isAbsolute(env.UPLOAD_DIR)).toBe(true);
    expect(path.isAbsolute(env.UPLOAD_TEMP_DIR)).toBe(true);
  });
});

describe("environment validation: invalid input stops the process", () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ["DATABASE_URL missing", {}, "DATABASE_URL"],
    ["DATABASE_URL is empty", { DATABASE_URL: "" }, "DATABASE_URL"],
    ["DATABASE_URL is not a postgres URL", { DATABASE_URL: "mysql://u:p@h/db" }, "DATABASE_URL"],
    ["PORT too large", { DATABASE_URL: VALID_URL, PORT: "99999" }, "PORT"],
    ["PORT zero", { DATABASE_URL: VALID_URL, PORT: "0" }, "PORT"],
    ["PORT not a number", { DATABASE_URL: VALID_URL, PORT: "abc" }, "PORT"],
    ["LOG_LEVEL unknown", { DATABASE_URL: VALID_URL, LOG_LEVEL: "loud" }, "LOG_LEVEL"],
    ["NODE_ENV unknown", { DATABASE_URL: VALID_URL, NODE_ENV: "staging" }, "NODE_ENV"],
    [
      "MAX_UPLOAD_FILES above 5",
      { DATABASE_URL: VALID_URL, MAX_UPLOAD_FILES: "6" },
      "MAX_UPLOAD_FILES",
    ],
    [
      "MAX_UPLOAD_FILES zero",
      { DATABASE_URL: VALID_URL, MAX_UPLOAD_FILES: "0" },
      "MAX_UPLOAD_FILES",
    ],
  ];

  it.each(cases)("%s", async (_label, vars, variableName) => {
    await expect(loadWith(vars)).rejects.toThrow("process.exit(1)");
    const output = errorOutput.join("\n");
    expect(output).toContain("Invalid environment configuration");
    expect(output).toContain(variableName);
  });

  it("never prints the value of a bad variable (it may be a secret)", async () => {
    await expect(
      loadWith({ DATABASE_URL: "mysql://admin:SuperSecret123@db.example.com/prod" }),
    ).rejects.toThrow("process.exit(1)");
    const output = errorOutput.join("\n");
    expect(output).not.toContain("SuperSecret123");
    expect(output).not.toContain("admin");
  });

  it("lists every problem, not just the first", async () => {
    await expect(
      loadWith({ DATABASE_URL: "mysql://x", PORT: "99999", LOG_LEVEL: "loud" }),
    ).rejects.toThrow("process.exit(1)");
    const output = errorOutput.join("\n");
    expect(output).toContain("DATABASE_URL");
    expect(output).toContain("PORT");
    expect(output).toContain("LOG_LEVEL");
  });
});
