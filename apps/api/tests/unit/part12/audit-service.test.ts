import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_LABELS,
  createAuditService,
  decodeAuditCursor,
  encodeAuditCursor,
  listAuditQuerySchema,
  sanitizeMeta,
} from "../../../src/modules/audit/audit.service.js";

describe("sanitizeMeta", () => {
  it("keeps plain ids, codes, numbers and flags", () => {
    expect(
      sanitizeMeta({
        batchId: "b1",
        sizeBytes: 1200,
        alreadyQueued: false,
        versionNo: 3,
        gap: null,
      }),
    ).toEqual({ batchId: "b1", sizeBytes: 1200, alreadyQueued: false, versionNo: 3, gap: null });
  });

  it("returns an empty object for nothing", () => {
    expect(sanitizeMeta(undefined)).toEqual({});
    expect(sanitizeMeta({})).toEqual({});
  });

  it.each([
    "password",
    "passwordHash",
    "secret",
    "sessionToken",
    "csrfToken",
    "cookie",
    "authorization",
    "apiKey",
    "api_key",
    "email",
    "userEmail",
    "phone",
    "mobile",
    "address",
    "fileName",
    "originalName",
    "customerName",
    "customerId",
    "rawSnippet",
    "content",
    "requestBody",
    "note",
    "comment",
  ])("drops the key %s", (key) => {
    expect(sanitizeMeta({ [key]: "something", kept: "yes" })).toEqual({ kept: "yes" });
  });

  it("drops values that look like an e-mail address, even under a harmless key", () => {
    expect(sanitizeMeta({ reason: "asha@example.com" })).toEqual({});
    expect(sanitizeMeta({ reason: "WRONG_PASSWORD" })).toEqual({ reason: "WRONG_PASSWORD" });
  });

  it("drops objects, arrays, functions, undefined and non-finite numbers", () => {
    expect(
      sanitizeMeta({
        a: { nested: 1 },
        b: [1, 2],
        c: () => 1,
        d: undefined,
        e: Number.NaN,
        f: Number.POSITIVE_INFINITY,
        g: 1n,
        h: Symbol("x"),
        ok: 1,
      }),
    ).toEqual({ ok: 1 });
  });

  it("drops keys that are not simple names", () => {
    expect(sanitizeMeta({ "bad key": 1, "../x": 1, "1abc": 1, "": 1, good_key: 1 })).toEqual({
      good_key: 1,
    });
  });

  it("cuts long text and limits the number of keys", () => {
    const long = sanitizeMeta({ text: "x".repeat(1000) });
    expect(String(long["text"]).length).toBe(200);

    const many = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, index]));
    expect(Object.keys(sanitizeMeta(many))).toHaveLength(20);
  });

  it("does not change the object it was given", () => {
    const input = { email: "a@b.co", ok: 1 };
    sanitizeMeta(input);
    expect(input).toEqual({ email: "a@b.co", ok: 1 });
  });
});

describe("actions", () => {
  it("have a readable label each", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(AUDIT_LABELS[action].length).toBeGreaterThan(3);
    }
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it("cover what the later parts need", () => {
    for (const action of ["MATCH_ACCEPTED", "MATCH_REJECTED", "CLAIM_EXPORTED"]) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });
});

describe("record", () => {
  function fakePrisma(create = vi.fn().mockResolvedValue({})) {
    return { client: { auditLog: { create } } as never, create };
  }

  it("saves the event with a cleaned meta", async () => {
    const { client, create } = fakePrisma();
    const { record } = createAuditService({ prisma: client });
    await record({
      userId: "u1",
      action: "UPLOAD",
      entityType: "UPLOADED_FILE",
      entityId: "f1",
      meta: { batchId: "b1", fileName: "customers.csv" },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        action: "UPLOAD",
        entityType: "UPLOADED_FILE",
        entityId: "f1",
        meta: { batchId: "b1" },
      },
    });
  });

  it("saves a failed sign-in with no user and no entity id", async () => {
    const { client, create } = fakePrisma();
    await createAuditService({ prisma: client }).record({
      action: "LOGIN_FAILED",
      entityType: "USER",
    });
    expect(create).toHaveBeenCalledWith({
      data: { userId: null, action: "LOGIN_FAILED", entityType: "USER", entityId: null, meta: {} },
    });
  });

  it("never throws when the database write fails", async () => {
    const { client } = fakePrisma(vi.fn().mockRejectedValue(new Error("db down")));
    await expect(
      createAuditService({ prisma: client }).record({ action: "LOGIN", entityType: "USER" }),
    ).resolves.toBeUndefined();
  });

  it("cuts an over-long entity type", async () => {
    const { client, create } = fakePrisma();
    await createAuditService({ prisma: client }).record({
      action: "LOGIN",
      entityType: "X".repeat(200),
    });
    expect(create.mock.calls[0]?.[0].data.entityType).toHaveLength(60);
  });
});

describe("list", () => {
  const row = (createdAt: string, action = "LOGIN") => ({
    id: randomUUID(),
    createdAt: new Date(createdAt),
    action,
    entityType: "USER",
    entityId: null,
    meta: { email: "leak@example.com", ok: 1 },
    user: { id: randomUUID(), name: "Asha", role: "FINANCE_EXECUTIVE" },
  });

  it("returns a page, a cursor when more exist, and cleans meta again on the way out", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        row("2026-11-09T10:00:03Z"),
        row("2026-11-09T10:00:02Z"),
        row("2026-11-09T10:00:01Z"),
      ]);
    const service = createAuditService({ prisma: { auditLog: { findMany } } as never });
    const page = await service.list({ limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items[0]).toMatchObject({ label: "Signed in", meta: { ok: 1 } });
    expect(JSON.stringify(page)).not.toContain("leak@example.com");
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 3,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  it("returns no cursor on the last page", async () => {
    const findMany = vi.fn().mockResolvedValue([row("2026-11-09T10:00:00Z")]);
    const page = await createAuditService({ prisma: { auditLog: { findMany } } as never }).list({
      limit: 5,
    });
    expect(page.nextCursor).toBeNull();
  });

  it("keeps an unknown stored action as its own label", async () => {
    const findMany = vi.fn().mockResolvedValue([row("2026-11-09T10:00:00Z", "FUTURE_ACTION")]);
    const page = await createAuditService({ prisma: { auditLog: { findMany } } as never }).list({
      limit: 5,
    });
    expect(page.items[0]?.label).toBe("FUTURE_ACTION");
  });

  it("turns the cursor into a keyset condition and passes the action filter", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const cursor = { createdAt: new Date("2026-11-09T10:00:00.000Z"), id: randomUUID() };
    await createAuditService({ prisma: { auditLog: { findMany } } as never }).list({
      limit: 10,
      action: "UPLOAD",
      cursor: encodeAuditCursor(cursor.createdAt, cursor.id),
    });
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        action: "UPLOAD",
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      },
    });
  });
});

describe("cursor and query", () => {
  it("round-trips", () => {
    const cursor = { createdAt: new Date("2026-11-09T10:20:30.123Z"), id: randomUUID() };
    expect(decodeAuditCursor(encodeAuditCursor(cursor.createdAt, cursor.id))).toEqual(cursor);
  });

  it.each([
    "garbage",
    "",
    Buffer.from("one").toString("base64url"),
    Buffer.from("nope|not-a-uuid").toString("base64url"),
    Buffer.from(`2026-13-45T00:00:00Z|${randomUUID()}`).toString("base64url"),
    Buffer.from(`2026-01-01T00:00:00Z|${randomUUID()}|x`).toString("base64url"),
  ])("rejects the cursor %j", (value) => {
    expect(() => decodeAuditCursor(value)).toThrow();
  });

  it("validates the list query", () => {
    expect(listAuditQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(listAuditQuerySchema.parse({ limit: "100", action: "LOGIN" })).toMatchObject({
      limit: 100,
      action: "LOGIN",
    });
    for (const bad of [
      { limit: "0" },
      { limit: "101" },
      { action: "DELETE_EVERYTHING" },
      { limit: "x" },
    ]) {
      expect(() => listAuditQuerySchema.parse(bad)).toThrow();
    }
  });
});
