// Part 1 + Part 2 together: the upload and source routes are only reachable by a signed-in
// finance executive. The app is imported inside beforeAll, after the upload folders are set,
// because the settings are read once when the app's code is first loaded.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder@example.test", password: "cofounder-password-1" };

const root = mkdtempSync(path.join(tmpdir(), "lk-auth-uploads-"));
const uploadDir = path.join(root, "uploads");
const tempDir = path.join(root, "tmp");
process.env["UPLOAD_DIR"] = uploadDir;
process.env["UPLOAD_TEMP_DIR"] = tempDir;

let prisma: PrismaClient;
let server: TestServer;
let base: string;
let seedSources: (client: PrismaClient) => Promise<void>;
let seedUsers: (client: PrismaClient, users: never[], cost: number) => Promise<void>;
let websiteId: string;

beforeAll(async () => {
  prisma = (await import("../../../src/db/prisma.js")).prisma;
  seedSources = (await import("../../../src/db/seed-sources.js")).seedSources;
  seedUsers = (await import("../../../src/db/seed-users.js")).seedUsers as typeof seedUsers;
  const { createApp } = await import("../../../src/app.js");
  server = await startServer(createApp({ loginRateLimitMax: 10_000 }));
  base = server.baseUrl;
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types" CASCADE',
  );
  rmSync(root, { recursive: true, force: true });
  await seedSources(prisma);
  await seedUsers(
    prisma,
    [
      { ...EXEC, name: "Test Executive", role: "FINANCE_EXECUTIVE" },
      { ...FOUNDER, name: "Test Founder", role: "CO_FOUNDER" },
    ] as never[],
    4,
  );
  websiteId = (await prisma.source.findUniqueOrThrow({ where: { name: "Website" } })).id;
});

function countFiles(dir: string): number {
  try {
    return readdirSync(dir).reduce((total, name) => {
      const full = path.join(dir, name);
      return total + (statSync(full).isDirectory() ? countFiles(full) : 1);
    }, 0);
  } catch {
    return 0; // the folder does not exist yet
  }
}

let counter = 0;
const uniqueCsv = () =>
  `Order ID,Value\nORD-${Date.now()}-${counter++},1499\nORD-${Date.now()}-${counter++},1199\n`;

function uploadForm(
  content = uniqueCsv(),
  name = "orders.csv",
  fileType = "ORDERS",
  sourceId = websiteId,
) {
  const form = new FormData();
  form.append("items", JSON.stringify([{ sourceId, fileType }]));
  form.append("files", new Blob([content], { type: "text/csv" }), name);
  return form;
}

const nothingStored = async () => {
  expect(countFiles(uploadDir)).toBe(0);
  expect(countFiles(tempDir)).toBe(0);
  expect(await prisma.uploadedFile.count()).toBe(0);
  expect(await prisma.uploadBatch.count()).toBe(0);
};

describe("signed out", () => {
  it("cannot reach any source or upload route (401), and nothing is stored", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const calls = [
      await call(base, "GET", "/api/sources"),
      await call(base, "GET", "/api/uploads"),
      await call(base, "GET", `/api/uploads/${id}`),
      await call(base, "POST", "/api/uploads", { form: uploadForm() }),
    ];
    for (const result of calls) {
      expect(result.status).toBe(401);
      expect(result.data.error.code).toBe("UNAUTHENTICATED");
    }
    await nothingStored();
  });
});

describe("co-founder (not allowed to upload)", () => {
  it("is refused with 403 on every source and upload route, even with a valid CSRF token", async () => {
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    const id = "00000000-0000-4000-8000-000000000001";
    const calls = [
      await call(base, "GET", "/api/sources", { cookie: founder.cookie }),
      await call(base, "GET", "/api/uploads", { cookie: founder.cookie }),
      await call(base, "GET", `/api/uploads/${id}`, { cookie: founder.cookie }),
      await call(base, "POST", "/api/uploads", {
        cookie: founder.cookie,
        csrf: founder.csrf,
        form: uploadForm(),
      }),
    ];
    for (const result of calls) {
      expect(result.status).toBe(403);
      expect(result.data.error.code).toBe("FORBIDDEN");
    }
    await nothingStored();
  });
});

describe("finance executive", () => {
  it("lists the nine seeded sources with the file types each may send", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const result = await call(base, "GET", "/api/sources", { cookie: exec.cookie });
    expect(result.status).toBe(200);
    expect(result.data.items).toHaveLength(9);
    const website = result.data.items.find((source: { name: string }) => source.name === "Website");
    expect(website.fileTypes).toEqual(["ORDERS"]);
    const warehouse = result.data.items.find(
      (source: { name: string }) => source.name === "Warehouse",
    );
    expect(warehouse.fileTypes).toEqual(["RETURN_SCAN"]);
  });

  it("is refused (403) when the CSRF token is missing or wrong, and nothing is stored", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    for (const csrf of [undefined, "not-the-token", founder.csrf]) {
      const result = await call(base, "POST", "/api/uploads", {
        cookie: exec.cookie,
        csrf,
        form: uploadForm(),
      });
      expect(result.status, String(csrf)).toBe(403);
    }
    await nothingStored();
  });

  it("uploads a file: 201, saved to disk, recorded against the signed-in user", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const result = await call(base, "POST", "/api/uploads", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      form: uploadForm(),
    });

    expect(result.status).toBe(201);
    const first = result.data.results[0];
    expect(first.status).toBe("ACCEPTED");
    expect(first.file).toMatchObject({
      sourceName: "Website",
      fileType: "ORDERS",
      status: "NEEDS_MAPPING",
      detectedRowCount: 2,
    });
    expect(countFiles(uploadDir)).toBe(1);
    expect(countFiles(tempDir)).toBe(0);

    const row = await prisma.uploadedFile.findUniqueOrThrow({ where: { id: first.file.id } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EXEC.email } });
    expect(row.uploadedById).toBe(user.id);
  });

  it("reports the same file uploaded again as a duplicate (409) and stores nothing new", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const content = uniqueCsv();
    const first = await call(base, "POST", "/api/uploads", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      form: uploadForm(content, "first.csv"),
    });
    const again = await call(base, "POST", "/api/uploads", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      form: uploadForm(content, "renamed.csv"),
    });

    expect(again.status).toBe(409);
    expect(again.data.results[0].status).toBe("DUPLICATE");
    expect(again.data.results[0].existing.id).toBe(first.data.results[0].file.id);
    expect(again.data.results[0].existing.originalName).toBe("first.csv");
    expect(countFiles(uploadDir)).toBe(1);
    expect(countFiles(tempDir)).toBe(0);
    expect(await prisma.uploadedFile.count()).toBe(1);
  });

  it("rejects a file type the source does not send (422) and stores nothing", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const result = await call(base, "POST", "/api/uploads", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      form: uploadForm(uniqueCsv(), "settlement.csv", "SETTLEMENT"),
    });
    expect(result.status).toBe(422);
    expect(result.data.results[0]).toMatchObject({
      status: "REJECTED",
      reason: "FILE_TYPE_NOT_ALLOWED",
    });
    // No file and no file record. Part 2 keeps one batch row per attempt, with the rejected count.
    expect(countFiles(uploadDir)).toBe(0);
    expect(countFiles(tempDir)).toBe(0);
    expect(await prisma.uploadedFile.count()).toBe(0);
    const batches = await prisma.uploadBatch.findMany();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ acceptedCount: 0, duplicateCount: 0, rejectedCount: 1 });
  });

  it("lists and fetches uploads, and answers 404 for an unknown one", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const upload = await call(base, "POST", "/api/uploads", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      form: uploadForm(),
    });
    const id = upload.data.results[0].file.id;

    const list = await call(base, "GET", "/api/uploads", { cookie: exec.cookie });
    expect(list.status).toBe(200);
    expect(list.data.items.map((item: { id: string }) => item.id)).toContain(id);

    const one = await call(base, "GET", `/api/uploads/${id}`, { cookie: exec.cookie });
    expect(one.status).toBe(200);
    expect(one.data.id).toBe(id);

    const missing = await call(base, "GET", "/api/uploads/00000000-0000-4000-8000-0000000000aa", {
      cookie: exec.cookie,
    });
    expect(missing.status).toBe(404);
  });

  it("loses access the moment the session ends", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    await call(base, "POST", "/api/auth/logout", { cookie: exec.cookie, csrf: exec.csrf });
    expect((await call(base, "GET", "/api/sources", { cookie: exec.cookie })).status).toBe(401);
    expect(
      (
        await call(base, "POST", "/api/uploads", {
          cookie: exec.cookie,
          csrf: exec.csrf,
          form: uploadForm(),
        })
      ).status,
    ).toBe(401);
    await nothingStored();
  });
});
