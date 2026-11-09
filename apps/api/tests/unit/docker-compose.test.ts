import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { apiRoot } from "../helpers/test-db.js";

const repoRoot = path.resolve(apiRoot, "..", "..");
const DATA_DIR = "/var/lib/postgresql/data";

interface Compose {
  services: {
    db: {
      image: string;
      restart?: string;
      environment: Record<string, string>;
      ports: string[];
      volumes: string[];
      healthcheck?: { test: string[] };
    };
  };
  volumes: Record<string, unknown>;
}

const compose = parse(
  fs.readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8"),
) as Compose;
const db = compose.services.db;

describe("docker-compose.yml: persistent storage", () => {
  it("mounts a named volume at the PostgreSQL data directory", () => {
    const dataMount = db.volumes.find((entry) => entry.endsWith(`:${DATA_DIR}`));
    expect(dataMount, "no mount found for the data directory").toBeDefined();
    const source = dataMount!.slice(0, dataMount!.length - DATA_DIR.length - 1);
    expect(source).toBe("leaklens-db-data");
  });

  it("declares that named volume at the top level", () => {
    expect(Object.keys(compose.volumes)).toContain("leaklens-db-data");
  });

  it("does not store the data in a project folder (no bind mount)", () => {
    for (const entry of db.volumes) {
      const source = entry.split(":")[0] ?? "";
      expect(source.startsWith(".") || source.startsWith("/") || source.includes("\\")).toBe(false);
    }
  });

  it("restarts the database container automatically unless it was stopped on purpose", () => {
    expect(db.restart).toBe("unless-stopped");
  });
});

describe("docker-compose.yml: safety", () => {
  it("uses a PostgreSQL image", () => {
    expect(db.image).toMatch(/^postgres:\d+/);
  });

  it("publishes the port on 127.0.0.1 only, so other machines cannot connect", () => {
    expect(db.ports.length).toBeGreaterThan(0);
    for (const port of db.ports) expect(port.startsWith("127.0.0.1:")).toBe(true);
  });

  it("maps host port 5433 so it cannot clash with a local PostgreSQL on 5432", () => {
    expect(db.ports).toContain("127.0.0.1:5433:5432");
  });

  it("reads the password from the environment and refuses to start without it", () => {
    const value = String(db.environment["POSTGRES_PASSWORD"]);
    expect(value).toContain("${POSTGRES_PASSWORD");
    expect(value).toContain(":?");
  });

  it("has a health check that uses pg_isready", () => {
    expect(db.healthcheck?.test.join(" ")).toContain("pg_isready");
  });
});

// ---------------------------------------------------------------------------------------------

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "generated", "dist", ".git", "storage"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

describe("secrets stay out of tracked files", () => {
  it("git ignores .env files but keeps .env.example", () => {
    const lines = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8").split(/\r?\n/);
    expect(lines).toContain(".env");
    expect(lines).toContain("!.env.example");
  });

  it("the .env.example files hold placeholders only", () => {
    const root = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    expect(root).toMatch(/POSTGRES_PASSWORD=change-me/);
    const api = fs.readFileSync(path.join(apiRoot, ".env.example"), "utf8");
    expect(api).toContain("USER:PASSWORD@");
  });

  it("the real database password does not appear in any other file", () => {
    const envPath = path.join(repoRoot, ".env");
    if (!fs.existsSync(envPath)) return; // nothing to check on a fresh checkout
    const match = /^POSTGRES_PASSWORD=(.+)$/m.exec(fs.readFileSync(envPath, "utf8"));
    const password = match?.[1]?.trim();
    expect(password, "root .env has no POSTGRES_PASSWORD").toBeTruthy();
    expect(password!.length).toBeGreaterThanOrEqual(16);

    const ignored = new Set([path.join(repoRoot, ".env"), path.join(apiRoot, ".env")]);
    const leaks = listFiles(repoRoot)
      .filter((file) => !ignored.has(file))
      .filter((file) => {
        try {
          return fs.readFileSync(file, "utf8").includes(password!);
        } catch {
          return false; // unreadable or binary
        }
      })
      .map((file) => path.relative(repoRoot, file));
    expect(leaks).toEqual([]);
  });
});
