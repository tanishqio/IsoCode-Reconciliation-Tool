import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const CONTAINER = "leaklens-db";
const DATA_DIR = "/var/lib/postgresql/data";

function docker(args: string[]): string | null {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

const dockerAvailable = docker(["version", "--format", "{{.Server.Version}}"]) !== null;

interface Mount {
  Type: string;
  Name?: string;
  Destination: string;
}
interface Inspect {
  State: { Running: boolean; Health?: { Status: string } };
  Mounts: Mount[];
  HostConfig: {
    RestartPolicy: { Name: string };
    PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  };
}

function inspect(): Inspect {
  const out = docker(["inspect", CONTAINER]);
  if (out === null)
    throw new Error(`Container "${CONTAINER}" not found. Run: docker compose up -d db`);
  return (JSON.parse(out) as Inspect[])[0]!;
}

describe.skipIf(!dockerAvailable)("the running leaklens-db container", () => {
  it("is running and healthy", () => {
    const info = inspect();
    expect(info.State.Running).toBe(true);
    expect(info.State.Health?.Status).toBe("healthy");
  });

  it("stores its data in a Docker named volume mounted at the PostgreSQL data directory", () => {
    const mount = inspect().Mounts.find((m) => m.Destination === DATA_DIR);
    expect(mount, "no mount at the data directory").toBeDefined();
    expect(mount!.Type).toBe("volume");
    expect(mount!.Name).toMatch(/leaklens-db-data$/);
  });

  it("the volume exists in Docker", () => {
    const name = inspect().Mounts.find((m) => m.Destination === DATA_DIR)!.Name!;
    expect(docker(["volume", "inspect", name, "--format", "{{.Name}}"])?.trim()).toBe(name);
  });

  it("restarts automatically unless stopped on purpose", () => {
    expect(inspect().HostConfig.RestartPolicy.Name).toBe("unless-stopped");
  });

  it("is reachable from this machine only, on port 5433", () => {
    const bindings = inspect().HostConfig.PortBindings["5432/tcp"];
    expect(bindings).toEqual([{ HostIp: "127.0.0.1", HostPort: "5433" }]);
  });
});
