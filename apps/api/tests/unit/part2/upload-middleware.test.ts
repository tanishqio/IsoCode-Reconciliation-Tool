import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import express from "express";
import multer from "multer";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ErrorBody } from "../../../src/lib/errors.js";
import { makeTempDir, buildForm, waitForNoFiles } from "../../helpers/part2-fixtures.js";
import { startServer, type TestServer } from "../../helpers/server.js";

let tempDir: string;
let server: TestServer;
let toUploadError: typeof import("../../../src/middleware/upload.js").toUploadError;

beforeAll(async () => {
  tempDir = makeTempDir("upload-middleware");
  process.env["UPLOAD_TEMP_DIR"] = tempDir;
  const upload = await import("../../../src/middleware/upload.js");
  const { errorHandler } = await import("../../../src/middleware/error-handler.js");
  const { requestLogger } = await import("../../../src/middleware/request-logger.js");
  toUploadError = upload.toUploadError;

  const receiver = upload.createFileReceiver({ maxFileBytes: 1024, maxFiles: 2 });
  const app = express();
  app.use(requestLogger);
  app.post("/up", receiver, (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    res.json({ fileCount: files.length, items: req.body?.items ?? null });
  });
  app.use(errorHandler);
  server = await startServer(app);
});

afterAll(async () => {
  await server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const small = (text = "a,b\n1,2\n") => ({ name: "x.csv", data: Buffer.from(text) });

async function post(body: BodyInit, headers?: Record<string, string>) {
  const response = await fetch(`${server.baseUrl}/up`, { method: "POST", body, headers });
  return {
    status: response.status,
    body: (await response.json()) as ErrorBody & { fileCount?: number; items?: string },
  };
}

describe("file receiver middleware", () => {
  it("passes valid files and the items field to the next handler", async () => {
    const { status, body } = await post(buildForm([{ x: 1 }], [small(), small("c\n")]));
    expect(status).toBe(200);
    expect(body.fileCount).toBe(2);
    expect(JSON.parse(body.items ?? "null")).toEqual([{ x: 1 }]);
  });

  it("still sees the items field when it is sent after the files", async () => {
    const { status, body } = await post(
      buildForm([{ x: 1 }], [small()], { itemsAfterFiles: true }),
    );
    expect(status).toBe(200);
    expect(JSON.parse(body.items ?? "null")).toEqual([{ x: 1 }]);
  });

  it("answers 413 PAYLOAD_TOO_LARGE for a file over the limit and leaves no temp file", async () => {
    const { status, body } = await post(
      buildForm([{ x: 1 }], [small(), { name: "big.csv", data: randomBytes(20 * 1024) }]),
    );
    expect(status).toBe(413);
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(body.error.details).toEqual({ maxFileBytes: 1024 });
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("answers 400 BAD_REQUEST for too many files and leaves no temp file", async () => {
    const { status, body } = await post(buildForm([], [small(), small("2\n"), small("3\n")]));
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("at most 2");
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("answers 400 when the files are sent in a field with another name", async () => {
    const { status, body } = await post(buildForm([], [small()], { fileField: "documents" }));
    expect(status).toBe(400);
    expect(body.error.message).toContain('"files" field');
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("answers 400 when the items field is too large", async () => {
    const { status, body } = await post(buildForm("x".repeat(20 * 1024), [small()]));
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("answers 400 when there are too many form fields", async () => {
    const form = buildForm([], [small()]);
    for (let index = 0; index < 8; index += 1) form.append(`extra${index}`, "v");
    const { status } = await post(form);
    expect(status).toBe(400);
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("answers 400 for a broken multipart body", async () => {
    const { status, body } = await post(
      '--abc\r\nContent-Disposition: form-data; name="files"; filename="a.csv"\r\n\r\ntruncated',
      {
        "content-type": "multipart/form-data; boundary=abc",
      },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("lets a request that is not multipart through with no files", async () => {
    const { status, body } = await post(JSON.stringify({ a: 1 }), {
      "content-type": "application/json",
    });
    expect(status).toBe(200);
    expect(body.fileCount).toBe(0);
  });
});

describe("toUploadError", () => {
  const options = { maxFileBytes: 50 * 1024 * 1024, maxFiles: 5 };

  it("describes the file size limit in whole megabytes", () => {
    const err = toUploadError(new multer.MulterError("LIMIT_FILE_SIZE", "files"), options);
    expect(err).toMatchObject({ status: 413, message: "A file is larger than the 50 MB limit." });
  });

  it("maps every other multer error to a 400", () => {
    for (const code of [
      "LIMIT_FIELD_KEY",
      "LIMIT_FIELD_VALUE",
      "LIMIT_FIELD_COUNT",
      "LIMIT_PART_COUNT",
    ] as const) {
      expect(toUploadError(new multer.MulterError(code), options)).toMatchObject({ status: 400 });
    }
  });

  it("returns unknown errors unchanged so they become a generic 500", () => {
    const original = new Error("disk full");
    expect(toUploadError(original, options)).toBe(original);
    expect(toUploadError("a string", options)).toBe("a string");
  });
});
