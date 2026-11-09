import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import multer from "multer";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { countFiles, makeTempDir, waitForNoFiles } from "../../helpers/part2-fixtures.js";
import { startServer, type TestServer } from "../../helpers/server.js";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

type HashStorage = typeof import("../../../src/lib/hash-storage.js").hashStorage;

interface Received {
  sha256: string;
  sizeBytes: number;
  head: string;
  tempPath: string;
}

let tempDir: string;
let hashStorage: HashStorage;
let normalServer: TestServer;
let strictServer: TestServer;

function buildApp(storage: HashStorage, limits: multer.Options["limits"]) {
  const upload = multer({ storage, limits });
  const app = express();
  app.post("/up", upload.array("files", limits?.files ?? 5), (req, res) => {
    const files = (req.files as Express.Multer.File[]).map((file): Received => ({
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      head: file.headBytes.toString("hex"),
      tempPath: file.tempPath,
    }));
    res.json(files);
  });
  app.use(
    (
      err: Error & { code?: string },
      _req: express.Request,
      res: express.Response,
      // Express only treats a function with four parameters as an error handler.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: err.code ?? err.message });
    },
  );
  return app;
}

beforeAll(async () => {
  tempDir = makeTempDir("hash-storage-temp");
  process.env["UPLOAD_TEMP_DIR"] = tempDir;
  ({ hashStorage } = await import("../../../src/lib/hash-storage.js"));
  normalServer = await startServer(buildApp(hashStorage, { fileSize: 8 * 1024 * 1024, files: 5 }));
  strictServer = await startServer(buildApp(hashStorage, { fileSize: 1024, files: 2 }));
});

afterAll(async () => {
  await normalServer.close();
  await strictServer.close();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function send(server: TestServer, files: { name?: string; data: Buffer }[]) {
  const form = new FormData();
  files.forEach((file, index) =>
    form.append("files", new Blob([new Uint8Array(file.data)]), file.name ?? `f${index}.csv`),
  );
  const response = await fetch(`${server.baseUrl}/up`, { method: "POST", body: form });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe("hashStorage through multer", () => {
  it("saves the file and returns its SHA-256, size and first bytes", async () => {
    const data = Buffer.from("order_id,amount\nA1,100\n");
    const { status, body } = await send(normalServer, [{ data }]);
    const [file] = body as Received[];
    expect(status).toBe(200);
    expect(file?.sha256).toBe(sha256(data));
    expect(file?.sizeBytes).toBe(data.length);
    expect(file?.head).toBe(data.subarray(0, 8).toString("hex"));
    expect(readFileSync(file!.tempPath).equals(data)).toBe(true);
  });

  it("handles a file much larger than one chunk without changing a byte", async () => {
    const data = randomBytes(3 * 1024 * 1024 - 17);
    const { body } = await send(normalServer, [{ data }]);
    const [file] = body as Received[];
    expect(file?.sha256).toBe(sha256(data));
    expect(file?.sizeBytes).toBe(data.length);
    expect(sha256(readFileSync(file!.tempPath))).toBe(sha256(data));
  });

  it("gives the same hash for the same bytes and a different hash for different bytes", async () => {
    const data = Buffer.from("same content");
    const first = ((await send(normalServer, [{ data }])).body as Received[])[0];
    const second = ((await send(normalServer, [{ data }])).body as Received[])[0];
    const other = (
      (await send(normalServer, [{ data: Buffer.from("same content!") }])).body as Received[]
    )[0];
    expect(second?.sha256).toBe(first?.sha256);
    expect(other?.sha256).not.toBe(first?.sha256);
  });

  it("returns only the bytes that exist for a file shorter than 8 bytes", async () => {
    const [file] = (await send(normalServer, [{ data: Buffer.from("ab") }])).body as Received[];
    expect(file?.head).toBe("6162");
    expect(file?.sizeBytes).toBe(2);
  });

  it("handles an empty file", async () => {
    const [file] = (await send(normalServer, [{ data: Buffer.alloc(0) }])).body as Received[];
    expect(file?.sizeBytes).toBe(0);
    expect(file?.head).toBe("");
    expect(file?.sha256).toBe(sha256(Buffer.alloc(0)));
  });

  it("keeps several files in one request apart", async () => {
    const files = [Buffer.from("one"), Buffer.from("two"), Buffer.from("three")];
    const { body } = await send(
      normalServer,
      files.map((data) => ({ data })),
    );
    const received = body as Received[];
    expect(received.map((file) => file.sha256)).toEqual(files.map(sha256));
    expect(new Set(received.map((file) => file.tempPath)).size).toBe(3);
  });

  it("names the temp file itself and never uses the uploaded file name", async () => {
    const { body } = await send(normalServer, [
      { name: "../../../evil name.csv", data: Buffer.from("x") },
    ]);
    const [file] = body as Received[];
    expect(path.dirname(file!.tempPath)).toBe(tempDir);
    expect(path.basename(file!.tempPath)).toMatch(/^[0-9a-f-]{36}\.part$/);
  });

  it("creates the temp folder when it does not exist", async () => {
    rmSync(tempDir, { recursive: true, force: true });
    const { status, body } = await send(normalServer, [{ data: Buffer.from("x") }]);
    expect(status).toBe(200);
    expect(existsSync((body as Received[])[0]!.tempPath)).toBe(true);
  });

  it("rejects a file over the size limit and leaves no temp file behind", async () => {
    const { status, body } = await send(strictServer, [
      { data: Buffer.from("small") },
      { data: randomBytes(50 * 1024) },
    ]);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "LIMIT_FILE_SIZE" });
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("rejects too many files and leaves no temp file behind", async () => {
    const { status, body } = await send(strictServer, [
      { data: Buffer.from("a") },
      { data: Buffer.from("b") },
      { data: Buffer.from("c") },
    ]);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "LIMIT_FILE_COUNT" });
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });
});

function engineCall<T>(run: (done: (error?: unknown, info?: T) => void) => void) {
  return new Promise<{ error?: unknown; info?: T }>((resolve) => {
    run((error, info) => resolve({ error, info }));
  });
}

describe("hashStorage engine functions", () => {
  it("reports a stream error and removes the half-written temp file", async () => {
    const stream = new Readable({
      read() {
        this.push(Buffer.from("partial data"));
        this.destroy(new Error("connection lost"));
      },
    });
    const result = await engineCall((done) =>
      hashStorage._handleFile(
        {} as express.Request,
        { stream } as unknown as Express.Multer.File,
        done,
      ),
    );
    expect((result.error as Error).message).toBe("connection lost");
    expect(result.info).toBeUndefined();
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("deletes the temp file when multer asks to remove it", async () => {
    const tempPath = path.join(tempDir, "to-remove.part");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(tempPath, "data");
    const result = await engineCall((done) =>
      hashStorage._removeFile({} as express.Request, { tempPath } as Express.Multer.File, (error) =>
        done(error),
      ),
    );
    expect(result.error).toBeNull();
    expect(existsSync(tempPath)).toBe(false);
  });

  it("does not fail when the file to remove is already gone", async () => {
    const tempPath = path.join(tempDir, "never-existed.part");
    const result = await engineCall((done) =>
      hashStorage._removeFile({} as express.Request, { tempPath } as Express.Multer.File, (error) =>
        done(error),
      ),
    );
    expect(result.error).toBeNull();
  });

  it("does not fail when the file was never saved (no temp path)", async () => {
    const result = await engineCall((done) =>
      hashStorage._removeFile({} as express.Request, {} as Express.Multer.File, (error) =>
        done(error),
      ),
    );
    expect(result.error).toBeNull();
  });

  it("leaves nothing in the temp folder after these tests", () => {
    expect(countFiles(tempDir)).toBe(0);
  });
});

describe("hashStorage when the temp folder cannot be created", () => {
  it("reports the error instead of crashing", async () => {
    const blocker = path.join(makeTempDir("hash-storage-blocker"), "a-file");
    writeFileSync(blocker, "not a folder");
    const previous = process.env["UPLOAD_TEMP_DIR"];
    process.env["UPLOAD_TEMP_DIR"] = path.join(blocker, "inside");
    vi.resetModules();
    try {
      const { hashStorage: brokenStorage } = await import("../../../src/lib/hash-storage.js");
      const stream = Readable.from([Buffer.from("data")]);
      const result = await engineCall((done) =>
        brokenStorage._handleFile(
          {} as express.Request,
          { stream } as unknown as Express.Multer.File,
          done,
        ),
      );
      expect(result.error).toBeInstanceOf(Error);
    } finally {
      process.env["UPLOAD_TEMP_DIR"] = previous;
      vi.resetModules();
    }
  });
});
