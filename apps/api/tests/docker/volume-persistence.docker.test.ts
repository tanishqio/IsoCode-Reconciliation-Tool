// Proves the mechanism behind "data survives restarts": a named volume mounted at the PostgreSQL
// data directory keeps its data after the container is deleted. Uses a throwaway container and
// volume with random names. It never touches the development container or its volume.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const suffix = randomBytes(4).toString("hex");
const VOLUME = `lk-persist-test-vol-${suffix}`;
const FIRST = `lk-persist-test-a-${suffix}`;
const SECOND = `lk-persist-test-b-${suffix}`;
const PASSWORD = randomBytes(12).toString("hex"); // throwaway; the container publishes no port
const IMAGE = "postgres:17";
const DATA_DIR = "/var/lib/postgresql/data";

function docker(args: string[], ignoreFailure = false): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (ignoreFailure) return "";
    const e = err as { stderr?: string; message: string };
    throw new Error(`docker ${args.join(" ")} failed: ${e.stderr ?? e.message}`, { cause: err });
  }
}

function startContainer(name: string) {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-v",
    `${VOLUME}:${DATA_DIR}`,
    IMAGE,
  ]);
}

async function waitUntilReady(name: string) {
  for (let i = 0; i < 60; i++) {
    const out = docker(["exec", name, "pg_isready", "-U", "postgres"], true);
    if (out.includes("accepting connections")) {
      // pg_isready can answer during the first-start setup; confirm a real query works.
      if (docker(["exec", name, "psql", "-U", "postgres", "-tAc", "SELECT 1"], true).trim() === "1")
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`PostgreSQL in ${name} did not become ready in time`);
}

const sql = (name: string, statement: string) =>
  docker(["exec", name, "psql", "-U", "postgres", "-tAc", statement]).trim();

afterAll(() => {
  docker(["rm", "-f", FIRST, SECOND], true);
  docker(["volume", "rm", "-f", VOLUME], true);
});

describe("named volume keeps PostgreSQL data after the container is deleted", () => {
  it("writes a row, deletes the container, and reads the row from a brand-new container", async () => {
    docker(["volume", "create", VOLUME]);

    startContainer(FIRST);
    await waitUntilReady(FIRST);
    sql(FIRST, "CREATE TABLE persistence_check (v text)");
    sql(FIRST, "INSERT INTO persistence_check VALUES ('survives-container-removal')");
    expect(sql(FIRST, "SELECT v FROM persistence_check")).toBe("survives-container-removal");

    docker(["rm", "-f", FIRST]);
    expect(docker(["ps", "-a", "--filter", `name=${FIRST}`, "--format", "{{.Names}}"]).trim()).toBe(
      "",
    );

    startContainer(SECOND);
    await waitUntilReady(SECOND);
    expect(sql(SECOND, "SELECT v FROM persistence_check")).toBe("survives-container-removal");
  });

  it("loses the data when the container uses no volume (this is why the volume matters)", async () => {
    const name = `lk-persist-test-novol-${suffix}`;
    const anonymous = `lk-persist-test-novol2-${suffix}`;
    try {
      // Without -v the image still creates an anonymous volume, so use --rm-style cleanup with -v flag on removal.
      docker(["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${PASSWORD}`, IMAGE]);
      await waitUntilReady(name);
      sql(name, "CREATE TABLE persistence_check (v text)");
      docker(["rm", "-f", "-v", name]); // -v also deletes the anonymous volume

      docker(["run", "-d", "--name", anonymous, "-e", `POSTGRES_PASSWORD=${PASSWORD}`, IMAGE]);
      await waitUntilReady(anonymous);
      const tables = sql(
        anonymous,
        "SELECT count(*) FROM pg_tables WHERE tablename = 'persistence_check'",
      );
      expect(tables).toBe("0");
    } finally {
      docker(["rm", "-f", "-v", name, anonymous], true);
    }
  });
});
