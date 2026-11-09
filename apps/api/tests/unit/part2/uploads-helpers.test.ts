import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../../src/lib/errors.js";
import { getRequestUser, requireRole, type RequestUser } from "../../../src/lib/request-user.js";
import {
  decodeCursor,
  encodeCursor,
  listUploadsQuerySchema,
  parseUploadItems,
  uploadIdParamSchema,
} from "../../../src/modules/uploads/uploads.schemas.js";
import {
  buildStoragePath,
  moveIntoStorage,
  removeFileQuietly,
  resolveInside,
} from "../../../src/modules/uploads/uploads.storage.js";
import { SOURCE_SEED } from "../../../src/db/seed-sources.js";
import { makeTempDir } from "../../helpers/part2-fixtures.js";
import type { Request } from "express";

describe("parseUploadItems", () => {
  const sourceId = randomUUID();
  const valid = JSON.stringify([{ sourceId, fileType: "ORDERS" }]);

  it("parses a valid list", () => {
    expect(parseUploadItems(valid, 1)).toEqual([{ sourceId, fileType: "ORDERS" }]);
  });

  it("accepts all five file types", () => {
    const types = ["ORDERS", "SETTLEMENT", "COD_REMITTANCE", "FREIGHT_INVOICE", "RETURN_SCAN"];
    const raw = JSON.stringify(types.map((fileType) => ({ sourceId, fileType })));
    expect(parseUploadItems(raw, 5)).toHaveLength(5);
  });

  it.each([undefined, null, 5, {}, "", "   "])("rejects a missing items field (%j)", (raw) => {
    expect(() => parseUploadItems(raw, 1)).toThrow(AppError);
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseUploadItems("{not json", 1)).toThrow(/valid JSON/);
  });

  it.each([
    ["not an array", JSON.stringify({ sourceId, fileType: "ORDERS" })],
    ["empty array", "[]"],
    ["bad uuid", JSON.stringify([{ sourceId: "abc", fileType: "ORDERS" }])],
    ["unknown file type", JSON.stringify([{ sourceId, fileType: "INVOICES" }])],
    ["missing file type", JSON.stringify([{ sourceId }])],
    ["extra key", JSON.stringify([{ sourceId, fileType: "ORDERS", admin: true }])],
    ["lower-case file type", JSON.stringify([{ sourceId, fileType: "orders" }])],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseUploadItems(raw, 1)).toThrow();
  });

  it("rejects more items than the maximum number of files", () => {
    const raw = JSON.stringify(Array.from({ length: 6 }, () => ({ sourceId, fileType: "ORDERS" })));
    expect(() => parseUploadItems(raw, 6, 5)).toThrow();
  });

  it("rejects when the number of items differs from the number of files", () => {
    expect(() => parseUploadItems(valid, 2)).toThrow(/one item for each file/);
    expect(() => parseUploadItems(valid, 0)).toThrow(/one item for each file/);
  });
});

describe("cursor", () => {
  it("round-trips a date and an id", () => {
    const cursor = { uploadedAt: new Date("2026-11-08T10:20:30.123Z"), id: randomUUID() };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    "not-base64-of-anything",
    Buffer.from("only-one-part").toString("base64url"),
    Buffer.from("nope|not-a-uuid").toString("base64url"),
    Buffer.from(`2026-13-45T00:00:00Z|${randomUUID()}`).toString("base64url"),
    Buffer.from(`2026-01-01T00:00:00Z|${randomUUID()}|extra`).toString("base64url"),
    "",
  ])("rejects an invalid cursor (%j)", (value) => {
    expect(() => decodeCursor(value)).toThrow(AppError);
  });
});

describe("listUploadsQuerySchema", () => {
  it("applies the default page size", () => {
    expect(listUploadsQuerySchema.parse({})).toEqual({ limit: 25 });
  });

  it("converts the limit from text", () => {
    expect(listUploadsQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  it.each([{ limit: "0" }, { limit: "101" }, { limit: "abc" }, { limit: "1.5" }])(
    "rejects %j",
    (query) => {
      expect(() => listUploadsQuerySchema.parse(query)).toThrow();
    },
  );

  it("accepts known filters and rejects unknown values", () => {
    const sourceId = randomUUID();
    expect(
      listUploadsQuerySchema.parse({ sourceId, fileType: "SETTLEMENT", status: "NEEDS_MAPPING" }),
    ).toMatchObject({ sourceId, fileType: "SETTLEMENT", status: "NEEDS_MAPPING" });
    expect(() => listUploadsQuerySchema.parse({ status: "DONE" })).toThrow();
    expect(() => listUploadsQuerySchema.parse({ fileType: "x" })).toThrow();
    expect(() => listUploadsQuerySchema.parse({ sourceId: "1" })).toThrow();
    expect(() => listUploadsQuerySchema.parse({ status: ["QUEUED", "FAILED"] })).toThrow();
  });
});

describe("uploadIdParamSchema", () => {
  it("accepts a uuid and rejects anything else", () => {
    const id = randomUUID();
    expect(uploadIdParamSchema.parse({ id })).toEqual({ id });
    expect(() => uploadIdParamSchema.parse({ id: "123" })).toThrow();
    expect(() => uploadIdParamSchema.parse({ id: "../etc/passwd" })).toThrow();
  });
});

describe("storage helpers", () => {
  let root: string;

  beforeAll(() => {
    root = makeTempDir("uploads-storage");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("builds a year/month/id.ext path in UTC and lower-cases the extension", () => {
    const id = randomUUID();
    expect(buildStoragePath(id, ".XLSX", new Date("2026-01-31T23:59:59Z"))).toBe(
      `2026/01/${id}.xlsx`,
    );
    expect(buildStoragePath(id, ".csv", new Date("2026-12-01T00:00:00Z"))).toBe(
      `2026/12/${id}.csv`,
    );
  });

  it("refuses a path that leaves the storage folder", () => {
    expect(() => resolveInside(root, "../outside.csv")).toThrow();
    expect(() => resolveInside(root, "2026/../../outside.csv")).toThrow();
    expect(resolveInside(root, "2026/11/a.csv")).toBe(path.resolve(root, "2026", "11", "a.csv"));
  });

  it("moves a file into a new folder tree and removes the source", async () => {
    const tempPath = path.join(root, "incoming.part");
    writeFileSync(tempPath, "payload");
    await moveIntoStorage(tempPath, root, "2026/11/final.csv");
    expect(existsSync(tempPath)).toBe(false);
    expect(readFileSync(path.join(root, "2026", "11", "final.csv"), "utf8")).toBe("payload");
  });

  it("does not move a file outside the storage folder", async () => {
    const tempPath = path.join(root, "incoming2.part");
    writeFileSync(tempPath, "payload");
    await expect(moveIntoStorage(tempPath, root, "../escape.csv")).rejects.toThrow();
    expect(existsSync(tempPath)).toBe(true);
  });

  it("removeFileQuietly ignores a missing file", async () => {
    await expect(removeFileQuietly(path.join(root, "missing"))).resolves.toBeUndefined();
  });
});

describe("request user helpers", () => {
  const withUser = (user?: RequestUser) => ({ user }) as unknown as Request;

  it("returns the user set by the authentication middleware", () => {
    const user: RequestUser = { id: randomUUID(), role: "FINANCE_EXECUTIVE" };
    expect(getRequestUser(withUser(user))).toBe(user);
  });

  it("throws 401 when there is no user", () => {
    expect(() => getRequestUser(withUser())).toThrow(AppError);
    try {
      getRequestUser(withUser());
    } catch (err) {
      expect(err).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    }
  });

  it("requireRole lets the allowed role through and blocks others with 403", () => {
    const guard = requireRole("FINANCE_EXECUTIVE");
    const calls: unknown[] = [];
    const next = (err?: unknown) => calls.push(err);

    guard(withUser({ id: "1", role: "FINANCE_EXECUTIVE" }), {} as never, next);
    guard(withUser({ id: "2", role: "CO_FOUNDER" }), {} as never, next);

    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("requireRole throws 401 when nobody is signed in", () => {
    expect(() => requireRole("CO_FOUNDER")(withUser(), {} as never, () => undefined)).toThrow(
      AppError,
    );
  });
});

describe("SOURCE_SEED", () => {
  it("has unique source names", () => {
    const names = SOURCE_SEED.map((source) => source.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("matches the brief: 1 website, 3 marketplaces, 2 quick-commerce apps, 2 aggregators, 1 warehouse", () => {
    const count = (kind: string) => SOURCE_SEED.filter((source) => source.kind === kind).length;
    expect(count("WEBSITE")).toBe(1);
    expect(count("MARKETPLACE")).toBe(3);
    expect(count("QUICK_COMMERCE")).toBe(2);
    expect(count("COURIER_AGGREGATOR")).toBe(2);
    expect(count("WAREHOUSE")).toBe(1);
  });

  it("allows every source at least one file type, with no repeats, and covers all five types", () => {
    const covered = new Set<string>();
    for (const source of SOURCE_SEED) {
      expect(source.fileTypes.length).toBeGreaterThan(0);
      expect(new Set(source.fileTypes).size).toBe(source.fileTypes.length);
      source.fileTypes.forEach((type) => covered.add(type));
    }
    expect([...covered].sort()).toEqual(
      ["COD_REMITTANCE", "FREIGHT_INVOICE", "ORDERS", "RETURN_SCAN", "SETTLEMENT"].sort(),
    );
  });
});
