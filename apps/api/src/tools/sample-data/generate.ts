import { RATE_CARD_SEED } from "../../db/seed-rate-cards.js";
import { bucketIndexForDays } from "../../modules/dashboard/age-buckets.js";
import { computeExpected, type CalcRule } from "../../modules/rate-cards/expected-amount.js";
import { paiseToAmount, parseAmountToPaise, shareOfPaise } from "../../modules/rate-cards/money.js";
import { toCsv } from "./csv.js";
import { createRng, type Rng } from "./random.js";

// Builds realistic, consistent sample files for all five report types, plus a "truth" list that says
// what each order SHOULD end up as. The files are synthetic: the assignment gives no raw files.
//
// The truth is worked out here with its own copy of the reconciliation rules written out in
// docs/decisions.md (received = payments + TCS + TDS; the gap that counts is more than the
// tolerance; unpaid after the due days; a return missing after the return window). It does not call the
// matching engine, so comparing the two is a real check of the engine.
//
// ASSUMPTIONS, all invented for the demo and labelled as such in docs/decisions.md:
//   - TCS is 1% and TDS is 0.1% of the order value, withheld from marketplace payouts (illustrative).
//   - Rates come from the sample rate cards (RATE_CARD_SEED), so the three sample rows of the
//     assignment work out exactly (1409, 899, -96).
//   - The share of each problem (about 4% unpaid, 4.5% short-paid, ...) is made up to give every
//     screen something to show.

export type FileType =
  "ORDERS" | "SETTLEMENT" | "COD_REMITTANCE" | "FREIGHT_INVOICE" | "RETURN_SCAN";

export type Scenario =
  | "SAMPLE_ROW"
  | "OK"
  | "UNPAID"
  | "RECENT_UNPAID"
  | "SHORT_PAID"
  | "FREIGHT_OVER"
  | "ORPHAN_PAYMENT"
  | "DUPLICATE_ROW"
  | "AWB_ONLY"
  | "RETURN_OK"
  | "RETURN_NO_SCAN"
  | "RETURN_FREIGHT_OVER";

export interface GenerateOptions {
  /** Number of orders across all channels. */
  orders: number;
  seed?: number;
  /** First day of the data, YYYY-MM-DD. */
  startDate?: string;
  /** Days over which orders are spread. */
  days?: number;
  /** The reconciliation settings the truth is worked out with. Defaults are the sample settings. */
  settings?: Partial<TruthSettings>;
}

export interface TruthSettings {
  tolerancePaise: bigint;
  codDueDays: number;
  settlementDueDays: number;
  returnWindowDays: number;
}

export interface GeneratedFile {
  /** File name, for example orders-website.csv. */
  name: string;
  /** The source (partner) the file is uploaded for. */
  source: string;
  fileType: FileType;
  content: string;
  /** Data rows, not counting the header row. */
  rows: number;
}

export interface TruthOrder {
  channel: string;
  orderId: string;
  scenario: Scenario;
  /** The status the engine should give this order. */
  status: string;
  expected: string | null;
  received: string | null;
  difference: string | null;
  /** The partner the money is claimed from, or null if nothing is at risk. */
  riskPartner: string | null;
  /** Cash at risk in rupees (0.00 for none). Returns are kept apart. */
  cashAtRisk: string;
  /** Order value of a return that never arrived, else 0.00. */
  returnValue: string;
  /** Age band index (0 to 3) of the cash at risk, or null. */
  ageBand: number | null;
  /** Which of the four problems it is, if any. */
  problem: "SHORT_PAID" | "UNPAID_PAST_DUE" | "FREIGHT_OVERCHARGED" | "RETURN_NOT_RECEIVED" | null;
}

export interface TaxTruth {
  partner: string;
  /** YYYY-MM of the settlement date. */
  month: string;
  lines: number;
  tcs: string;
  tds: string;
}

export interface GeneratedDataset {
  options: Required<Omit<GenerateOptions, "settings">> & { settings: TruthSettings };
  files: GeneratedFile[];
  truth: TruthOrder[];
  /** The newest date anywhere in the files: "today" for the due-date rules. */
  asOf: string;
  summary: {
    orders: number;
    byScenario: Record<string, number>;
    byStatus: Record<string, number>;
    /** Payment lines with no order ID and no AWB (they cannot be matched). */
    orphanLines: number;
    /** Settlement rows written twice on purpose (the second copy is dropped on upload). */
    duplicateRows: number;
    /** Settlement lines that will be saved, per partner and month. */
    tax: TaxTruth[];
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const dayNumber = (date: Date) => Math.floor(date.getTime() / DAY_MS);

interface ChannelSpec {
  name: string;
  kind: "WEBSITE" | "MARKETPLACE" | "QUICK_COMMERCE";
  prefix: string;
  firstNumber: number;
  weight: number;
}

const CHANNELS: ChannelSpec[] = [
  { name: "Website", kind: "WEBSITE", prefix: "ORD-W-", firstNumber: 200000, weight: 40 },
  { name: "Marketplace 1", kind: "MARKETPLACE", prefix: "ORD-M-", firstNumber: 88000, weight: 14 },
  { name: "Marketplace 2", kind: "MARKETPLACE", prefix: "ORD-M2-", firstNumber: 41000, weight: 10 },
  { name: "Marketplace 3", kind: "MARKETPLACE", prefix: "ORD-M3-", firstNumber: 17000, weight: 8 },
  {
    name: "Quick Commerce 1",
    kind: "QUICK_COMMERCE",
    prefix: "ORD-Q1-",
    firstNumber: 5000,
    weight: 16,
  },
  {
    name: "Quick Commerce 2",
    kind: "QUICK_COMMERCE",
    prefix: "ORD-Q2-",
    firstNumber: 9000,
    weight: 12,
  },
];

const COURIERS = ["Aggregator 1", "Aggregator 2"] as const;
const WEIGHTS = [250, 400, 450, 700, 900, 1200, 1800, 2500];
const PRICES = [499, 599, 799, 899, 999, 1199, 1299, 1499, 1799, 1999, 2398, 2999, 3499];
const TCS_BASIS_POINTS = 100; // 1%
const TDS_BASIS_POINTS = 10; // 0.1%

const DEFAULT_SETTINGS: TruthSettings = {
  tolerancePaise: 1000n,
  codDueDays: 7,
  settlementDueDays: 14,
  returnWindowDays: 7,
};

// ---------------------------------------------------------------------------------------------
// Rate cards, as the calculator wants them.
// ---------------------------------------------------------------------------------------------

const RULES = new Map<string, CalcRule[]>(
  RATE_CARD_SEED.map((card) => [
    `${card.channel}|${card.courier ?? ""}`,
    card.rules.map((rule) => ({
      ruleType: rule.ruleType,
      minWeightGrams: rule.minWeightGrams ?? null,
      maxWeightGrams: rule.maxWeightGrams ?? null,
      basisPoints: rule.basisPoints ?? null,
      amountPaise: rule.amount == null ? null : parseAmountToPaise(rule.amount),
    })),
  ]),
);

function rulesFor(channel: string, courier: string | null): CalcRule[] {
  const rules = RULES.get(`${channel}|${courier ?? ""}`) ?? RULES.get(`${channel}|`);
  if (!rules) throw new Error(`No sample rate card for ${channel}.`);
  return rules;
}

function slabsOf(rules: CalcRule[]): CalcRule[] {
  return rules
    .filter((rule) => rule.ruleType === "FREIGHT_SLAB")
    .sort((a, b) => (a.minWeightGrams ?? 0) - (b.minWeightGrams ?? 0));
}

function slabIndex(slabs: CalcRule[], weight: number): number {
  return slabs.findIndex(
    (slab) =>
      weight >= (slab.minWeightGrams ?? 0) &&
      (slab.maxWeightGrams === null || weight <= slab.maxWeightGrams),
  );
}

function flatFee(rules: CalcRule[], type: CalcRule["ruleType"]): bigint {
  return rules.find((rule) => rule.ruleType === type)?.amountPaise ?? 0n;
}

// ---------------------------------------------------------------------------------------------
// Orders and what happens to each one
// ---------------------------------------------------------------------------------------------

interface Plan {
  channel: ChannelSpec;
  courier: string | null;
  orderId: string;
  awb: string | null;
  valuePaise: bigint;
  paymentType: "COD" | "PREPAID";
  weight: number;
  dayOffset: number;
  orderDate: Date;
  deliveredAt: Date;
  returned: boolean;
  returnedAt: Date | null;
  scenario: Scenario;
  /** Fixed amounts for the assignment's three sample rows. */
  fixed?: { shortBy?: bigint; reverseBilled?: bigint; unpaid?: boolean };
}

interface PaymentLine {
  net: bigint;
  tcs: bigint;
  tds: bigint;
  date: Date;
}
interface Lines {
  settlement: PaymentLine[];
  cod: { amount: bigint; date: Date }[];
  forwardFreight: { amount: bigint; date: Date }[];
  reverseFreight: { amount: bigint; date: Date }[];
  scans: { date: Date }[];
}

interface Outcome {
  status: string;
  expected: bigint | null;
  received: bigint | null;
  difference: bigint | null;
  freightExpected: bigint | null;
  freightBilled: bigint;
  dueDate: Date | null;
}

function expectedFor(plan: Plan): bigint {
  const rules = rulesFor(plan.channel.name, plan.courier);
  const calc = computeExpected(rules, {
    orderValuePaise: plan.valuePaise,
    paymentType: plan.paymentType,
    weightGrams: plan.weight,
    isReturn: plan.returned,
  });
  if (!calc.ok) throw new Error(`Sample rate card cannot price ${plan.orderId}: ${calc.code}`);
  return calc.expectedPaise;
}

/** Our own copy of the status rules (see the header comment). Does not use the matching engine. */
function outcomeOf(plan: Plan, lines: Lines, asOf: Date, settings: TruthSettings): Outcome {
  const expected = expectedFor(plan);
  const rules = rulesFor(plan.channel.name, plan.courier);
  const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);

  const settlementNet = sum(lines.settlement.map((line) => line.net));
  const tax = sum(lines.settlement.map((line) => line.tcs + line.tds));
  const codRemitted = sum(lines.cod.map((line) => line.amount));
  const forward = sum(lines.forwardFreight.map((line) => line.amount));
  const reverse = sum(lines.reverseFreight.map((line) => line.amount));
  const paymentsIn = settlementNet + tax + codRemitted;
  const received = plan.returned ? paymentsIn - reverse : paymentsIn;

  const slab = slabsOf(rules)[slabIndex(slabsOf(rules), plan.weight)];
  const freightExpected = plan.returned
    ? flatFee(rules, "REVERSE_FREIGHT")
    : (slab?.amountPaise ?? null);
  const freightLines = lines.forwardFreight.length + lines.reverseFreight.length;
  const freightBilled = plan.returned ? reverse : forward;
  const freightOver =
    freightExpected !== null &&
    freightLines > 0 &&
    freightBilled - freightExpected > settings.tolerancePaise;

  const base = { expected, freightExpected, freightBilled };
  const result = (
    status: string,
    parts: Partial<Pick<Outcome, "received" | "difference" | "dueDate">> = {},
  ): Outcome => ({ ...base, received: null, difference: null, dueDate: null, ...parts, status });
  const tolerance = settings.tolerancePaise;
  const differenceOf = (value: bigint) => value - expected;

  if (plan.returned) {
    if (lines.scans.length === 0) {
      const due = addDays(plan.returnedAt ?? plan.deliveredAt, settings.returnWindowDays);
      return asOf > due
        ? result("RETURN_NOT_RECEIVED", {
            received,
            difference: differenceOf(received),
            dueDate: due,
          })
        : result("PENDING", { dueDate: due });
    }
    const difference = differenceOf(received);
    if (freightOver) return result("FREIGHT_OVERCHARGED", { received, difference });
    return result(
      difference < -tolerance ? "SHORT_PAID" : difference > tolerance ? "OVERPAID" : "SETTLED",
      { received, difference },
    );
  }

  if (plan.channel.kind === "WEBSITE" && plan.paymentType === "PREPAID") {
    return result("NOT_TRACKED");
  }

  const gotPayment = lines.settlement.length + lines.cod.length > 0;
  if (!gotPayment) {
    const days = plan.paymentType === "COD" ? settings.codDueDays : settings.settlementDueDays;
    const due = addDays(plan.deliveredAt, days);
    return asOf > due
      ? result("UNPAID_PAST_DUE", { received, difference: differenceOf(received), dueDate: due })
      : result("PENDING", { dueDate: due });
  }

  const difference = differenceOf(received);
  const status =
    difference < -tolerance
      ? "SHORT_PAID"
      : difference > tolerance
        ? "OVERPAID"
        : freightOver
          ? "FREIGHT_OVERCHARGED"
          : "SETTLED";
  return result(status, { received, difference });
}

// ---------------------------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------------------------

const isWebsitePrepaid = (plan: Plan) =>
  plan.channel.kind === "WEBSITE" && plan.paymentType === "PREPAID";

interface QuotaContext {
  early: (plan: Plan) => boolean;
  /** The newest delivery date of any order, in milliseconds. */
  maxDelivered: number;
}

interface QuotaRule {
  scenario: Scenario;
  eligible: (plan: Plan, context: QuotaContext) => boolean;
  /** How many orders get this scenario, from the number of orders and of returned orders. */
  count: (orders: number, returned: number, pool: number) => number;
}

const QUOTAS: QuotaRule[] = [
  {
    scenario: "ORPHAN_PAYMENT",
    eligible: (p, { early }) =>
      !p.returned && !isWebsitePrepaid(p) && early(p) && p.scenario === "OK",
    count: (n) => Math.max(1, Math.round(n * 0.015)),
  },
  {
    scenario: "UNPAID",
    eligible: (p, { early }) =>
      !p.returned && !isWebsitePrepaid(p) && early(p) && p.scenario === "OK",
    count: (n) => Math.max(1, Math.round(n * 0.04)),
  },
  {
    scenario: "RECENT_UNPAID",
    // Prepaid payouts are due 14 days after delivery. An order delivered in the last two days of the
    // data is still inside that window on the newest date, so it ends as "pending", not "unpaid".
    eligible: (p, { maxDelivered }) =>
      !p.returned &&
      p.channel.kind !== "WEBSITE" &&
      p.deliveredAt.getTime() >= maxDelivered - 2 * DAY_MS &&
      p.scenario === "OK",
    count: (n) => Math.max(1, Math.round(n * 0.01)),
  },
  {
    scenario: "SHORT_PAID",
    eligible: (p) => !p.returned && !isWebsitePrepaid(p) && p.scenario === "OK",
    count: (n) => Math.max(1, Math.round(n * 0.045)),
  },
  {
    scenario: "FREIGHT_OVER",
    eligible: (p) =>
      !p.returned && p.channel.kind === "WEBSITE" && p.paymentType === "COD" && p.scenario === "OK",
    count: (n) => Math.max(1, Math.round(n * 0.03)),
  },
  {
    scenario: "DUPLICATE_ROW",
    eligible: (p) => !p.returned && p.channel.kind !== "WEBSITE" && p.scenario === "OK",
    count: (n) => Math.max(1, Math.round(n * 0.015)),
  },
  {
    scenario: "AWB_ONLY",
    eligible: (p) =>
      !p.returned && p.channel.kind === "WEBSITE" && p.paymentType === "COD" && p.scenario === "OK",
    count: (_n, _r, pool) => Math.round(pool * 0.3),
  },
  {
    scenario: "RETURN_NO_SCAN",
    eligible: (p, { early }) => p.returned && early(p) && p.scenario === "OK",
    count: (_n, returned) => Math.max(1, Math.round(returned * 0.25)),
  },
  {
    scenario: "RETURN_FREIGHT_OVER",
    eligible: (p) => p.returned && p.channel.kind === "WEBSITE" && p.scenario === "OK",
    count: (_n, returned) => Math.max(1, Math.round(returned * 0.2)),
  },
];

export function generateDataset(input: GenerateOptions): GeneratedDataset {
  const orders = Math.max(1, Math.floor(input.orders));
  const seed = input.seed ?? 1;
  const startDate = input.startDate ?? "2026-08-01";
  const days = Math.max(40, input.days ?? 90);
  const settings: TruthSettings = { ...DEFAULT_SETTINGS, ...input.settings };
  const rng = createRng(seed);
  const start = new Date(`${startDate}T00:00:00Z`);
  const early = (plan: Plan) => plan.dayOffset <= days - 25;

  // 1. The orders -----------------------------------------------------------------------------
  const usedIds = new Set<string>();
  const counters = new Map<string, number>();
  let awbCounter = 0;
  const nextId = (channel: ChannelSpec): string => {
    let number = counters.get(channel.name) ?? channel.firstNumber;
    let id = `${channel.prefix}${number}`;
    while (usedIds.has(id)) {
      number += 1;
      id = `${channel.prefix}${number}`;
    }
    counters.set(channel.name, number + 1);
    usedIds.add(id);
    return id;
  };

  const channelByName = (name: string) =>
    CHANNELS.find((channel) => channel.name === name) as ChannelSpec;

  function makePlan(channel: ChannelSpec, overrides: Partial<Plan> = {}): Plan {
    const dayOffset = overrides.dayOffset ?? rng.int(0, days - 1);
    const orderDate = addDays(start, dayOffset);
    const deliveredAt = addDays(orderDate, rng.int(2, 5));
    const isWebsite = channel.kind === "WEBSITE";
    const paymentType =
      overrides.paymentType ?? (isWebsite && rng.chance(0.55) ? "COD" : "PREPAID");
    const price = BigInt(rng.pick(PRICES)) * 100n + (rng.chance(0.15) ? 50n : 0n);
    return {
      channel,
      courier: isWebsite ? (rng.chance(0.7) ? COURIERS[0] : COURIERS[1]) : null,
      orderId: nextId(channel),
      awb: isWebsite ? `AWB${1_000_000_000 + awbCounter++}` : null,
      valuePaise: price,
      paymentType,
      weight: rng.pick(WEIGHTS),
      dayOffset,
      orderDate,
      deliveredAt,
      returned: false,
      returnedAt: null,
      scenario: "OK",
      ...overrides,
    };
  }

  const plans: Plan[] = [];

  // The three sample rows of the assignment, so the demo shows the brief's own examples.
  if (orders >= 10) {
    const day = 4;
    const sample = (channel: string, id: string, overrides: Partial<Plan>) => {
      const spec = channelByName(channel);
      usedIds.add(id);
      plans.push(
        makePlan(spec, {
          orderId: id,
          dayOffset: day,
          orderDate: addDays(start, day),
          deliveredAt: addDays(start, day + 3),
          courier: spec.kind === "WEBSITE" ? "Aggregator 1" : null,
          scenario: "SAMPLE_ROW",
          ...overrides,
        }),
      );
    };
    // ORD-W-204118: website COD, 1499, expected 1409, nothing received.
    sample("Website", "ORD-W-204118", {
      paymentType: "COD",
      valuePaise: 149900n,
      weight: 450,
      fixed: { unpaid: true },
    });
    // ORD-M-88120: marketplace prepaid, 1199, expected 899, received 862 (37 short).
    sample("Marketplace 1", "ORD-M-88120", {
      paymentType: "PREPAID",
      valuePaise: 119900n,
      weight: 450,
      fixed: { shortBy: 3700n },
    });
    // ORD-W-204377: website prepaid, 2398, returned, expected -96, billed 142 (46 over).
    sample("Website", "ORD-W-204377", {
      paymentType: "PREPAID",
      valuePaise: 239800n,
      weight: 450,
      returned: true,
      returnedAt: addDays(start, day + 7),
      fixed: { reverseBilled: 14200n },
    });
  }

  const totalWeight = CHANNELS.reduce((sum, channel) => sum + channel.weight, 0);
  const remaining = orders - plans.length;
  for (let index = 0; index < remaining; index += 1) {
    let roll = rng.next() * totalWeight;
    let channel = CHANNELS[0] as ChannelSpec;
    for (const candidate of CHANNELS) {
      roll -= candidate.weight;
      if (roll < 0) {
        channel = candidate;
        break;
      }
    }
    const plan = makePlan(channel);
    if (rng.chance(0.08)) {
      plan.returned = true;
      plan.returnedAt = addDays(plan.deliveredAt, rng.int(2, 6));
    }
    plans.push(plan);
  }

  // 2. Which orders get which problem ------------------------------------------------------------
  const returnedCount = plans.filter((plan) => plan.returned).length;
  const order = rng.shuffle(plans.filter((plan) => plan.scenario === "OK"));
  const context: QuotaContext = {
    early,
    maxDelivered: plans.reduce((latest, plan) => Math.max(latest, plan.deliveredAt.getTime()), 0),
  };
  for (const rule of QUOTAS) {
    const pool = order.filter((plan) => rule.eligible(plan, context));
    for (const plan of pool.slice(0, rule.count(orders, returnedCount, pool.length))) {
      plan.scenario = rule.scenario;
    }
  }
  for (const plan of plans) {
    if (plan.scenario === "OK" && plan.returned) plan.scenario = "RETURN_OK";
  }

  // 3. The lines each order produces ---------------------------------------------------------------
  const linesOf = new Map<Plan, Lines>();
  const rows = {
    orders: new Map<string, (string | number | null)[][]>(),
    settlement: new Map<string, (string | number | null)[][]>(),
    cod: new Map<string, (string | number | null)[][]>(),
    freight: new Map<string, (string | number | null)[][]>(),
    scans: [] as (string | number | null)[][],
  };
  const push = <K extends "orders" | "settlement" | "cod" | "freight">(
    table: K,
    key: string,
    row: (string | number | null)[],
  ) => {
    const list = rows[table].get(key) ?? [];
    rows[table].set(key, list);
    list.push(row);
  };

  let orphanLines = 0;
  let duplicateRows = 0;
  let settlementCounter = 0;
  const savedSettlement: { partner: string; date: Date; tcs: bigint; tds: bigint }[] = [];
  const invoiceOf = (courier: string, date: Date) =>
    `INV-${courier.replace("Aggregator ", "A")}-${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(Math.floor((date.getUTCDate() - 1) / 7) + 1)}`;
  const utrOf = (courier: string, date: Date) =>
    `UTR-${courier.replace("Aggregator ", "A")}-${isoDay(date).replaceAll("-", "")}`;

  function settlementRow(
    plan: Plan | null,
    channel: ChannelSpec,
    type: "SALE" | "RETURN",
    line: PaymentLine,
    withOrderId: boolean,
  ) {
    settlementCounter += 1;
    const ref = `STL-${channel.prefix.replaceAll("-", "")}-${settlementCounter}`;
    push("settlement", channel.name, [
      ref,
      withOrderId && plan ? plan.orderId : null,
      isoDay(line.date),
      type,
      paiseToAmount(line.net),
      paiseToAmount(line.tcs),
      paiseToAmount(line.tds),
    ]);
    savedSettlement.push({ partner: channel.name, date: line.date, tcs: line.tcs, tds: line.tds });
    return ref;
  }

  for (const plan of plans) {
    const lines: Lines = {
      settlement: [],
      cod: [],
      forwardFreight: [],
      reverseFreight: [],
      scans: [],
    };
    linesOf.set(plan, lines);
    const rules = rulesFor(plan.channel.name, plan.courier);
    const expected = expectedFor(plan);
    const reverse = flatFee(rules, "REVERSE_FREIGHT");
    const isWebsite = plan.channel.kind === "WEBSITE";
    const courier = plan.courier;

    push("orders", plan.channel.name, [
      plan.orderId,
      isoDay(plan.orderDate),
      paiseToAmount(plan.valuePaise),
      plan.paymentType === "COD" ? "COD" : "Prepaid",
      plan.returned ? "Returned to warehouse" : "Delivered",
      plan.awb,
      courier,
      plan.weight,
      isoDay(plan.deliveredAt),
      plan.returnedAt ? isoDay(plan.returnedAt) : null,
    ]);

    if (plan.returned) {
      const returnedAt = plan.returnedAt as Date;
      const billed =
        plan.fixed?.reverseBilled ??
        (plan.scenario === "RETURN_FREIGHT_OVER"
          ? reverse + BigInt(rng.int(30, 60)) * 100n
          : reverse);
      if (isWebsite && courier) {
        const date = addDays(returnedAt, 1);
        lines.reverseFreight.push({ amount: billed, date });
        push("freight", courier, [
          invoiceOf(courier, date),
          plan.awb,
          rng.chance(0.4) ? null : plan.orderId,
          "REVERSE",
          plan.weight,
          paiseToAmount(billed),
          isoDay(date),
        ]);
      } else {
        const line = { net: -reverse, tcs: 0n, tds: 0n, date: addDays(returnedAt, rng.int(3, 8)) };
        lines.settlement.push(line);
        settlementRow(plan, plan.channel, "RETURN", line, true);
      }
      if (plan.scenario !== "RETURN_NO_SCAN") {
        const date = addDays(returnedAt, rng.int(1, 3));
        lines.scans.push({ date });
        const withOrderId = !isWebsite || rng.chance(0.7);
        rows.scans.push([plan.awb, withOrderId ? plan.orderId : null, isoDay(date)]);
      }
      continue;
    }

    // Delivered. The courier's forward freight line (website orders only).
    if (isWebsite && courier) {
      const slabs = slabsOf(rules);
      const index = slabIndex(slabs, plan.weight);
      const correct = slabs[index]?.amountPaise ?? 0n;
      let billed = correct;
      let billedWeight = plan.weight;
      if (plan.scenario === "FREIGHT_OVER") {
        // The classic leak: billed one weight slab too high.
        const higher = slabs[index + 1];
        billed = higher?.amountPaise ?? correct + 2500n;
        billedWeight = higher?.minWeightGrams ?? plan.weight + 500;
      }
      const date = addDays(plan.deliveredAt, rng.int(1, 3));
      lines.forwardFreight.push({ amount: billed, date });
      push("freight", courier, [
        invoiceOf(courier, date),
        plan.awb,
        rng.chance(0.4) ? null : plan.orderId,
        "FORWARD",
        billedWeight,
        paiseToAmount(billed),
        isoDay(date),
      ]);
    }

    if (isWebsitePrepaid(plan)) continue; // paid through a gateway that has no file here

    const unpaid =
      plan.scenario === "UNPAID" ||
      plan.scenario === "RECENT_UNPAID" ||
      plan.fixed?.unpaid === true;
    if (unpaid) continue;

    if (plan.paymentType === "COD" && courier) {
      const delta =
        plan.scenario === "SHORT_PAID"
          ? BigInt(rng.int(20, 150)) * 100n
          : (plan.fixed?.shortBy ?? 0n);
      const date = addDays(plan.deliveredAt, rng.int(2, 5));
      const amount = expected - delta;
      if (plan.scenario === "ORPHAN_PAYMENT") {
        orphanLines += 1;
        push("cod", courier, [
          `UTR-ORPHAN-${orphanLines}`,
          null,
          null,
          isoDay(date),
          paiseToAmount(amount),
        ]);
      } else {
        lines.cod.push({ amount, date });
        push("cod", courier, [
          utrOf(courier, date),
          plan.awb,
          plan.scenario === "AWB_ONLY" ? null : plan.orderId,
          isoDay(date),
          paiseToAmount(amount),
        ]);
      }
      continue;
    }

    // Marketplace or quick-commerce payout, with TCS and TDS withheld.
    const tcs = shareOfPaise(plan.valuePaise, TCS_BASIS_POINTS);
    const tds = shareOfPaise(plan.valuePaise, TDS_BASIS_POINTS);
    const shortBy =
      plan.scenario === "SHORT_PAID"
        ? BigInt(rng.int(20, 180)) * 100n
        : (plan.fixed?.shortBy ?? 0n);
    const line = {
      net: expected - tcs - tds - shortBy,
      tcs,
      tds,
      date: addDays(plan.deliveredAt, rng.int(5, 12)),
    };
    if (plan.scenario === "ORPHAN_PAYMENT") {
      orphanLines += 1;
      settlementRow(null, plan.channel, "SALE", line, false);
    } else {
      lines.settlement.push(line);
      settlementRow(plan, plan.channel, "SALE", line, true);
      if (plan.scenario === "DUPLICATE_ROW") {
        // The same row twice: the second copy is dropped when the file is read.
        const copy = rows.settlement.get(plan.channel.name)?.at(-1);
        if (copy) {
          rows.settlement.get(plan.channel.name)?.push([...copy]);
          duplicateRows += 1;
        }
      }
    }
  }

  // 4. "Today" is the newest date anywhere in the files, exactly as the matching step finds it ----------
  let newest = 0;
  const see = (date: Date | null) => {
    if (date && date.getTime() > newest) newest = date.getTime();
  };
  for (const plan of plans) {
    see(plan.orderDate);
    see(plan.deliveredAt);
    see(plan.returnedAt);
    const lines = linesOf.get(plan) as Lines;
    lines.settlement.forEach((line) => see(line.date));
    lines.cod.forEach((line) => see(line.date));
    lines.forwardFreight.forEach((line) => see(line.date));
    lines.reverseFreight.forEach((line) => see(line.date));
    lines.scans.forEach((line) => see(line.date));
  }
  for (const saved of savedSettlement) see(saved.date);
  // Orphan lines count too: the engine reads every saved line.
  for (const [, list] of rows.cod)
    for (const row of list) see(new Date(`${String(row[3])}T00:00:00Z`));
  const asOf = new Date(newest);

  // 5. The truth ---------------------------------------------------------------------------------
  const truth: TruthOrder[] = [];
  const byScenario: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const plan of plans) {
    const outcome = outcomeOf(plan, linesOf.get(plan) as Lines, asOf, settings);
    byScenario[plan.scenario] = (byScenario[plan.scenario] ?? 0) + 1;
    byStatus[outcome.status] = (byStatus[outcome.status] ?? 0) + 1;

    let cash = 0n;
    let problem: TruthOrder["problem"] = null;
    let returnValue = 0n;
    if (outcome.status === "SHORT_PAID" || outcome.status === "UNPAID_PAST_DUE") {
      cash = outcome.difference !== null && outcome.difference < 0n ? -outcome.difference : 0n;
      problem = outcome.status;
    } else if (outcome.status === "FREIGHT_OVERCHARGED") {
      cash =
        outcome.freightExpected !== null
          ? outcome.freightBilled - outcome.freightExpected
          : outcome.difference !== null && outcome.difference < 0n
            ? -outcome.difference
            : 0n;
      if (cash < 0n) cash = 0n;
      problem = "FREIGHT_OVERCHARGED";
    } else if (outcome.status === "RETURN_NOT_RECEIVED") {
      returnValue = plan.valuePaise;
      problem = "RETURN_NOT_RECEIVED";
    }

    const courierHandles =
      problem === "FREIGHT_OVERCHARGED" ||
      problem === "RETURN_NOT_RECEIVED" ||
      plan.paymentType === "COD";
    const partner = problem
      ? courierHandles && plan.courier
        ? plan.courier
        : plan.channel.name
      : null;
    const anchor = outcome.dueDate ?? plan.deliveredAt;
    const ageBand =
      problem && problem !== "RETURN_NOT_RECEIVED"
        ? bucketIndexForDays(Math.max(0, dayNumber(asOf) - dayNumber(anchor)))
        : null;

    truth.push({
      channel: plan.channel.name,
      orderId: plan.orderId,
      scenario: plan.scenario,
      status: outcome.status,
      expected: outcome.expected === null ? null : paiseToAmount(outcome.expected),
      received: outcome.received === null ? null : paiseToAmount(outcome.received),
      difference: outcome.difference === null ? null : paiseToAmount(outcome.difference),
      riskPartner: partner,
      cashAtRisk: paiseToAmount(cash),
      returnValue: paiseToAmount(returnValue),
      ageBand,
      problem,
    });
  }

  // Tax truth: the settlement lines that will be saved (a duplicate row is dropped).
  const taxMap = new Map<string, TaxTruth & { tcsPaise: bigint; tdsPaise: bigint }>();
  for (const saved of savedSettlement) {
    const month = isoDay(saved.date).slice(0, 7);
    const key = `${saved.partner}|${month}`;
    const entry = taxMap.get(key) ?? {
      partner: saved.partner,
      month,
      lines: 0,
      tcs: "0.00",
      tds: "0.00",
      tcsPaise: 0n,
      tdsPaise: 0n,
    };
    entry.lines += 1;
    entry.tcsPaise += saved.tcs;
    entry.tdsPaise += saved.tds;
    taxMap.set(key, entry);
  }
  const tax = [...taxMap.values()]
    .map(({ tcsPaise, tdsPaise, ...entry }) => ({
      ...entry,
      tcs: paiseToAmount(tcsPaise),
      tds: paiseToAmount(tdsPaise),
    }))
    .sort((a, b) => a.partner.localeCompare(b.partner) || a.month.localeCompare(b.month));

  // 6. The files ---------------------------------------------------------------------------------
  const slug = (name: string) => name.toLowerCase().replaceAll(" ", "-");
  const files: GeneratedFile[] = [];
  const addFile = (
    name: string,
    source: string,
    fileType: FileType,
    headers: string[],
    list: (string | number | null)[][],
  ) => {
    files.push({ name, source, fileType, content: toCsv(headers, list), rows: list.length });
  };

  for (const channel of CHANNELS) {
    addFile(
      `orders-${slug(channel.name)}.csv`,
      channel.name,
      "ORDERS",
      [
        "Order ID",
        "Order Date",
        "Order Value",
        "Payment Mode",
        "Delivery Status",
        "AWB",
        "Courier",
        "Weight (g)",
        "Delivered On",
        "Returned On",
      ],
      rows.orders.get(channel.name) ?? [],
    );
  }
  for (const channel of CHANNELS.filter((candidate) => candidate.kind !== "WEBSITE")) {
    addFile(
      `settlement-${slug(channel.name)}.csv`,
      channel.name,
      "SETTLEMENT",
      ["Settlement Ref", "Order ID", "Settled On", "Line Type", "Net Received", "TCS", "TDS"],
      rows.settlement.get(channel.name) ?? [],
    );
  }
  for (const courier of COURIERS) {
    addFile(
      `cod-remittance-${slug(courier)}.csv`,
      courier,
      "COD_REMITTANCE",
      ["UTR", "AWB", "Order ID", "Remitted On", "Remitted Amount"],
      rows.cod.get(courier) ?? [],
    );
    addFile(
      `freight-invoice-${slug(courier)}.csv`,
      courier,
      "FREIGHT_INVOICE",
      [
        "Invoice No",
        "AWB",
        "Order ID",
        "Charge Type",
        "Billed Weight (g)",
        "Billed Amount",
        "Charged On",
      ],
      rows.freight.get(courier) ?? [],
    );
  }
  addFile(
    "return-scans-warehouse.csv",
    "Warehouse",
    "RETURN_SCAN",
    ["AWB", "Order ID", "Scanned At"],
    rows.scans,
  );

  return {
    options: { orders, seed, startDate, days, settings },
    files: files.filter((file) => file.rows > 0),
    truth,
    asOf: asOf.toISOString(),
    summary: { orders: plans.length, byScenario, byStatus, orphanLines, duplicateRows, tax },
  };
}

export type { Rng };
