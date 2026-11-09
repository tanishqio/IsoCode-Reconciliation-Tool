import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/app.js";
import { prisma } from "../../../src/db/prisma.js";
import { seedRateCards } from "../../../src/db/seed-rate-cards.js";
import { seedSources } from "../../../src/db/seed-sources.js";
import { seedUsers } from "../../../src/db/seed-users.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder@example.test", password: "cofounder-password-1" };

let server: TestServer;
let base: string;
let exec: { cookie: string; csrf: string };
let founder: { cookie: string; csrf: string };

beforeAll(async () => {
  server = await startServer(createApp({ loginRateLimitMax: 10_000 }));
  base = server.baseUrl;
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]); // never empty tables outside the test database
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users", "rate_cards" CASCADE');
  await seedSources(prisma);
  await seedUsers(
    prisma,
    [
      { ...EXEC, name: "Test Executive", role: "FINANCE_EXECUTIVE" },
      { ...FOUNDER, name: "Test Founder", role: "CO_FOUNDER" },
    ],
    4,
  );
  exec = await signIn(base, EXEC.email, EXEC.password);
  founder = await signIn(base, FOUNDER.email, FOUNDER.password);
});

const sourceId = async (name: string) =>
  (await prisma.source.findUniqueOrThrow({ where: { name } })).id;

async function cardId(channel: string, courier: string | null, who = exec) {
  const result = await call(base, "GET", "/api/rate-cards", { cookie: who.cookie });
  const card = result.data.items.find(
    (item: { channel: { name: string }; courier: { name: string } | null }) =>
      item.channel.name === channel && (item.courier?.name ?? null) === courier,
  );
  return card.id as string;
}

const calculate = (body: Record<string, unknown>, who = exec) =>
  call(base, "POST", "/api/rate-cards/calculate", {
    cookie: who.cookie,
    csrf: who.csrf,
    json: body,
  });

describe("access", () => {
  it("needs a signed-in user for every route", async () => {
    expect((await call(base, "GET", "/api/rate-cards")).status).toBe(401);
    expect((await call(base, "GET", "/api/rate-cards/" + crypto.randomUUID())).status).toBe(401);
    expect((await call(base, "POST", "/api/rate-cards/calculate", { json: {} })).status).toBe(401);
  });

  it("lets the co-founder read and use the check panel, but not create or change a card", async () => {
    await seedRateCards(prisma);
    const list = await call(base, "GET", "/api/rate-cards", { cookie: founder.cookie });
    expect(list.status).toBe(200);
    const id = await cardId("Marketplace 1", null, founder);

    expect(
      (await call(base, "GET", `/api/rate-cards/${id}`, { cookie: founder.cookie })).status,
    ).toBe(200);
    const check = await calculate(
      { rateCardId: id, paymentType: "PREPAID", orderValue: "1199" },
      founder,
    );
    expect(check.status).toBe(200);

    const rules = [{ ruleType: "FIXED_FEE", amount: "10" }];
    const create = await call(base, "POST", "/api/rate-cards", {
      cookie: founder.cookie,
      csrf: founder.csrf,
      json: { channelSourceId: await sourceId("Website"), rules },
    });
    expect(create.status).toBe(403);
    const update = await call(base, "PUT", `/api/rate-cards/${id}`, {
      cookie: founder.cookie,
      csrf: founder.csrf,
      json: { rules },
    });
    expect(update.status).toBe(403);
    expect(await prisma.rateCard.count()).toBe(7); // nothing changed
  });

  it("refuses a change without the CSRF token", async () => {
    const result = await call(base, "POST", "/api/rate-cards", {
      cookie: exec.cookie,
      json: {
        channelSourceId: await sourceId("Website"),
        rules: [{ ruleType: "FIXED_FEE", amount: "10" }],
      },
    });
    expect(result.status).toBe(403);
    expect(await prisma.rateCard.count()).toBe(0);
  });
});

describe("the demo cards", () => {
  it("are created once: running the seed again changes nothing", async () => {
    expect(await seedRateCards(prisma)).toEqual({ created: 7, skipped: 0 });
    expect(await seedRateCards(prisma)).toEqual({ created: 0, skipped: 7 });
    expect(await prisma.rateCard.count()).toBe(7);
  });

  it("are listed with their rules, marked as sample data, in channel order", async () => {
    await seedRateCards(prisma);
    const { status, data } = await call(base, "GET", "/api/rate-cards", { cookie: exec.cookie });
    expect(status).toBe(200);
    expect(data.items).toHaveLength(7);
    expect(data.items.every((card: { isSampleData: boolean }) => card.isSampleData)).toBe(true);
    expect(data.items.every((card: { status: string }) => card.status === "ACTIVE")).toBe(true);

    const names = data.items.map(
      (card: { channel: { name: string }; courier: { name: string } | null }) =>
        `${card.channel.name} / ${card.courier?.name ?? "-"}`,
    );
    expect(names).toEqual([
      "Marketplace 1 / -",
      "Marketplace 2 / -",
      "Marketplace 3 / -",
      "Quick Commerce 1 / -",
      "Quick Commerce 2 / -",
      "Website / Aggregator 1",
      "Website / Aggregator 2",
    ]);

    const marketplace1 = data.items[0];
    expect(marketplace1.versionNo).toBe(1);
    expect(marketplace1.createdByName).toBe("Test Executive");
    expect(marketplace1.rules.map((rule: { ruleType: string }) => rule.ruleType)).toEqual([
      "COMMISSION",
      "FIXED_FEE",
      "FREIGHT_SLAB",
      "REVERSE_FREIGHT",
    ]);
    expect(marketplace1.rules[0]).toMatchObject({ basisPoints: 2000, amount: null });
    expect(marketplace1.rules[2]).toMatchObject({
      amount: "35.20",
      minWeightGrams: 0,
      maxWeightGrams: null,
    });
  });

  it("work out the three sample rows of the assignment", async () => {
    await seedRateCards(prisma);
    const website = await cardId("Website", "Aggregator 1");
    const marketplace = await cardId("Marketplace 1", null);

    const row1 = await calculate({
      rateCardId: website,
      paymentType: "COD",
      orderValue: "1499",
      weightGrams: 450,
    });
    expect(row1.data).toMatchObject({ ok: true, expected: "1409.00", versionNo: 1 });
    expect(row1.data.lines).toEqual([
      { label: "Order value", amount: "1499.00" },
      { label: "Delivery charge (0 to 500 g)", amount: "-60.00" },
      { label: "COD fee", amount: "-30.00" },
    ]);

    const row2 = await calculate({
      rateCardId: marketplace,
      paymentType: "PREPAID",
      orderValue: "1199",
    });
    expect(row2.data).toMatchObject({ ok: true, expected: "899.00" });

    const row3 = await calculate({
      rateCardId: website,
      paymentType: "PREPAID",
      orderValue: "2398",
      isReturn: true,
    });
    expect(row3.data).toMatchObject({ ok: true, expected: "-96.00" });
  });

  it("answer 200 with ok:false when an order cannot be worked out, not an error", async () => {
    await seedRateCards(prisma);
    const website = await cardId("Website", "Aggregator 1");
    const result = await calculate({ rateCardId: website, paymentType: "COD", orderValue: "1499" });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ ok: false, code: "MISSING_WEIGHT" });
  });

  it("answer 404 for a card that does not exist and 422 for a bad request", async () => {
    const missing = await calculate({
      rateCardId: crypto.randomUUID(),
      paymentType: "COD",
      orderValue: "10",
    });
    expect(missing.status).toBe(404);
    await seedRateCards(prisma);
    const id = await cardId("Marketplace 1", null);
    const bad = await calculate({ rateCardId: id, paymentType: "COD", orderValue: "ten" });
    expect(bad.status).toBe(422);
    expect(bad.data.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("creating a card", () => {
  const create = (json: unknown, who = exec) =>
    call(base, "POST", "/api/rate-cards", { cookie: who.cookie, csrf: who.csrf, json });

  it("saves a new card as version 1, with rules in a fixed order and amounts to two decimals", async () => {
    const result = await create({
      channelSourceId: await sourceId("Website"),
      note: "  Checked with the courier  ",
      rules: [
        { ruleType: "COD_FEE", amount: "30" },
        { ruleType: "FREIGHT_SLAB", minWeightGrams: 501, maxWeightGrams: 1000, amount: "90.5" },
        { ruleType: "FREIGHT_SLAB", maxWeightGrams: 500, amount: "60" },
      ],
    });
    expect(result.status).toBe(201);
    expect(result.data).toMatchObject({
      versionNo: 1,
      status: "ACTIVE",
      courier: null,
      isSampleData: false,
      note: "Checked with the courier",
      effectiveFrom: null,
      createdByName: "Test Executive",
    });
    expect(result.data.rules).toMatchObject([
      { ruleType: "FREIGHT_SLAB", minWeightGrams: 0, maxWeightGrams: 500, amount: "60.00" },
      { ruleType: "FREIGHT_SLAB", minWeightGrams: 501, maxWeightGrams: 1000, amount: "90.50" },
      { ruleType: "COD_FEE", appliesToPayment: "COD", amount: "30.00" },
    ]);
  });

  it("refuses a second card for the same channel and courier, and points at the first", async () => {
    await seedRateCards(prisma);
    const result = await create({
      channelSourceId: await sourceId("Website"),
      courierSourceId: await sourceId("Aggregator 1"),
      rules: [{ ruleType: "FIXED_FEE", amount: "10" }],
    });
    expect(result.status).toBe(409);
    expect(result.data.error.code).toBe("CONFLICT");
    expect(result.data.error.details.existingId).toBe(await cardId("Website", "Aggregator 1"));
    expect(await prisma.rateCard.count()).toBe(7);
  });

  it("reports problems per field with a 422 and saves nothing", async () => {
    const result = await create({
      channelSourceId: await sourceId("Website"),
      rules: [
        { ruleType: "FIXED_FEE", amount: "60.123" },
        { ruleType: "FREIGHT_SLAB", minWeightGrams: 0, maxWeightGrams: 500, amount: "60" },
        { ruleType: "FREIGHT_SLAB", minWeightGrams: 400, maxWeightGrams: 900, amount: "90" },
      ],
    });
    expect(result.status).toBe(422);
    const paths = result.data.error.details.map((detail: { path: string }) => detail.path);
    expect(paths).toContain("rules.0.amount");
    expect(paths).toContain("rules.2.minWeightGrams");
    expect(await prisma.rateCard.count()).toBe(0);
  });

  it("only accepts a channel as the channel and a courier as the courier", async () => {
    const warehouseAsChannel = await create({
      channelSourceId: await sourceId("Aggregator 1"),
      rules: [{ ruleType: "FIXED_FEE", amount: "1" }],
    });
    expect(warehouseAsChannel.status).toBe(422);
    expect(warehouseAsChannel.data.error.details[0].path).toBe("channelSourceId");

    const marketplaceAsCourier = await create({
      channelSourceId: await sourceId("Website"),
      courierSourceId: await sourceId("Marketplace 1"),
      rules: [{ ruleType: "FIXED_FEE", amount: "1" }],
    });
    expect(marketplaceAsCourier.status).toBe(422);
    expect(marketplaceAsCourier.data.error.details[0].path).toBe("courierSourceId");
    expect(await prisma.rateCard.count()).toBe(0);
  });

  it("lets only one of two simultaneous requests for the same pair win", async () => {
    const body = {
      channelSourceId: await sourceId("Website"),
      rules: [{ ruleType: "FIXED_FEE", amount: "10" }],
    };
    const results = await Promise.all([create(body), create(body), create(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await prisma.rateCard.count()).toBe(1);
  });
});

describe("editing a card makes a new version", () => {
  const update = (id: string, json: unknown, who = exec) =>
    call(base, "PUT", `/api/rate-cards/${id}`, { cookie: who.cookie, csrf: who.csrf, json });
  const newRules = [
    { ruleType: "COMMISSION", basisPoints: 1900 },
    { ruleType: "FIXED_FEE", amount: "25" },
    { ruleType: "FREIGHT_SLAB", amount: "35.20" },
  ];

  it("keeps the old version, closes it on the change date and activates the new one", async () => {
    await seedRateCards(prisma);
    const oldId = await cardId("Marketplace 1", null);
    const before = Date.now();
    const result = await update(oldId, { rules: newRules });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ versionNo: 2, status: "ACTIVE", isSampleData: true });
    expect(result.data.id).not.toBe(oldId);
    expect(Date.parse(result.data.effectiveFrom)).toBeGreaterThanOrEqual(before - 1000);
    expect(result.data.rules[0]).toMatchObject({ ruleType: "COMMISSION", basisPoints: 1900 });

    const old = await call(base, "GET", `/api/rate-cards/${oldId}`, { cookie: exec.cookie });
    expect(old.data).toMatchObject({ versionNo: 1, status: "SUPERSEDED" });
    expect(old.data.effectiveTo).toBe(result.data.effectiveFrom);
    expect(old.data.rules[0]).toMatchObject({ ruleType: "COMMISSION", basisPoints: 2000 }); // untouched
  });

  it("shows only current versions by default and every version on request", async () => {
    await seedRateCards(prisma);
    await update(await cardId("Marketplace 1", null), { rules: newRules });

    const current = await call(base, "GET", "/api/rate-cards", { cookie: exec.cookie });
    expect(current.data.items).toHaveLength(7);
    const all = await call(base, "GET", "/api/rate-cards?includeOlder=true", {
      cookie: exec.cookie,
    });
    expect(all.data.items).toHaveLength(8);
    const marketplace = all.data.items.filter(
      (card: { channel: { name: string } }) => card.channel.name === "Marketplace 1",
    );
    expect(marketplace.map((card: { versionNo: number }) => card.versionNo)).toEqual([2, 1]);
  });

  it("refuses to edit an old version, and says where to go", async () => {
    await seedRateCards(prisma);
    const oldId = await cardId("Marketplace 1", null);
    await update(oldId, { rules: newRules });
    const again = await update(oldId, { rules: newRules });
    expect(again.status).toBe(409);
    expect(again.data.error.message).toMatch(/current version/i);
    expect(
      await prisma.rateCard.count({ where: { channelSourceId: await sourceId("Marketplace 1") } }),
    ).toBe(2);
  });

  it("lets only one of two simultaneous edits win and never leaves two current versions", async () => {
    await seedRateCards(prisma);
    const id = await cardId("Marketplace 2", null);
    const results = await Promise.all([
      update(id, { rules: newRules }),
      update(id, { rules: newRules }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const active = await prisma.rateCard.count({
      where: { channelSourceId: await sourceId("Marketplace 2"), status: "ACTIVE" },
    });
    expect(active).toBe(1);
  });

  it("can clear the sample label when the values are real, and changes the note", async () => {
    await seedRateCards(prisma);
    const result = await update(await cardId("Marketplace 3", null), {
      rules: newRules,
      isSampleData: false,
      note: "Rates from the signed agreement",
    });
    expect(result.data).toMatchObject({
      isSampleData: false,
      note: "Rates from the signed agreement",
    });
  });

  it("changes the calculated amount for the new version only", async () => {
    await seedRateCards(prisma);
    const oldId = await cardId("Marketplace 1", null);
    const created = await update(oldId, { rules: newRules });
    const input = { paymentType: "PREPAID", orderValue: "1199" };
    const withOld = await calculate({ rateCardId: oldId, ...input });
    const withNew = await calculate({ rateCardId: created.data.id, ...input });
    expect(withOld.data.expected).toBe("899.00");
    // 1199 - 227.81 (19%) - 25 - 35.20
    expect(withNew.data.expected).toBe("910.99");
  });

  it("answers 404 for an unknown card and 422 for a body that changes the channel", async () => {
    expect((await update(crypto.randomUUID(), { rules: newRules })).status).toBe(404);
    await seedRateCards(prisma);
    const id = await cardId("Marketplace 1", null);
    const bad = await update(id, { rules: newRules, channelSourceId: await sourceId("Website") });
    expect(bad.status).toBe(422);
  });
});
