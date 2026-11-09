import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { LineKind, PaymentType } from "../../../generated/prisma/enums.js";
import { env } from "../../config/env.js";
import type { JobHandler } from "../../jobs/job-types.js";
import { logger } from "../../lib/logger.js";
import { AiUnavailableError, type AiConfig } from "../mapping/ai-client.js";
import { paiseToAmount, parseAmountToPaise } from "../rate-cards/money.js";
import { loadSettings } from "../reconciliation/matching.js";
import { rankWithAi, type RankCase } from "./ai-rank.js";
import {
  isAmbiguous,
  normaliseKey,
  rankCandidates,
  type Candidate,
  type CandidateOrder,
  type LineFacts,
  type Rules,
} from "./suggest-rules.js";

const MAX_LINES = 20_000;
/** At most this many ambiguous lines go to the AI in one run, to bound the cost. */
const MAX_AI_LINES = 200;
const INSERT_BATCH = 2000;

const absBig = (value: bigint) => (value < 0n ? -value : value);

const toPaise = (text: string | null): bigint | null => {
  if (text === null) return null;
  const negative = text.startsWith("-");
  const value = parseAmountToPaise(negative ? text.slice(1) : text);
  return value === null ? null : negative ? -value : value;
};

interface OrderRow {
  pk: string;
  orderId: string;
  awb: string | null;
  channelId: string;
  courierId: string | null;
  paymentType: PaymentType;
  orderDate: Date;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  deliveryStatus: string;
  value: string;
  expected: string | null;
  freightExpected: string | null;
  lineCounts: {
    settlement?: number;
    codRemittance?: number;
    freight?: number;
    returnScan?: number;
  };
}

interface LineRow {
  id: string;
  partnerId: string;
  date: Date | null;
  amount: string | null;
  orderIdRaw: string | null;
  awb: string | null;
}

/** The unmatched lines of the four kinds, as the rules want them. */
async function loadUnmatchedLines(prisma: PrismaClient): Promise<LineFacts[]> {
  const run = (sql: string) => prisma.$queryRawUnsafe<LineRow[]>(sql);
  const [settlement, cod, freight, scans] = await Promise.all([
    run(`SELECT id::text AS id, "sourceId"::text AS "partnerId", "settledOn" AS date,
                ("netReceived" + tcs + tds)::text AS amount, "orderIdRaw", NULL AS awb
         FROM settlement_lines WHERE "matchStatus" = 'UNMATCHED' LIMIT ${MAX_LINES}`),
    run(`SELECT id::text AS id, "aggregatorSourceId"::text AS "partnerId", "remittedOn" AS date,
                "remittedAmount"::text AS amount, "orderIdRaw", awb
         FROM cod_remittance_lines WHERE "matchStatus" = 'UNMATCHED' LIMIT ${MAX_LINES}`),
    run(`SELECT id::text AS id, "aggregatorSourceId"::text AS "partnerId", "chargedOn" AS date,
                "billedAmount"::text AS amount, "orderIdRaw", awb
         FROM freight_lines WHERE "matchStatus" = 'UNMATCHED' LIMIT ${MAX_LINES}`),
    run(`SELECT id::text AS id, "warehouseSourceId"::text AS "partnerId", "scannedAt" AS date,
                NULL AS amount, "orderIdRaw", awb
         FROM return_scans WHERE "matchStatus" = 'UNMATCHED' LIMIT ${MAX_LINES}`),
  ]);
  const wrap = (rows: LineRow[], kind: LineKind): LineFacts[] =>
    rows.map((row) => ({
      id: row.id,
      kind,
      partnerId: row.partnerId,
      date: row.date,
      amountPaise: toPaise(row.amount),
      orderIdRaw: row.orderIdRaw,
      awb: row.awb,
    }));
  return [
    ...wrap(settlement, "SETTLEMENT"),
    ...wrap(cod, "COD_REMITTANCE"),
    ...wrap(freight, "FREIGHT"),
    ...wrap(scans, "RETURN_SCAN"),
  ];
}

async function loadOrders(prisma: PrismaClient): Promise<CandidateOrder[]> {
  const rows = await prisma.$queryRawUnsafe<OrderRow[]>(`
    SELECT o.id::text AS pk, o."orderId", o.awb, o."channelSourceId"::text AS "channelId",
           o."courierSourceId"::text AS "courierId", o."paymentType", o."orderDate", o."deliveredAt",
           o."returnedAt", o."deliveryStatus", o.value::text AS value, r.expected::text AS expected,
           r."freightExpected"::text AS "freightExpected", r."lineCounts"
    FROM customer_orders o JOIN order_results r ON r."orderPk" = o.id`);
  return rows.map((row) => ({
    pk: row.pk,
    orderId: row.orderId,
    awb: row.awb,
    channelId: row.channelId,
    courierId: row.courierId,
    paymentType: row.paymentType,
    orderDate: row.orderDate,
    deliveredAt: row.deliveredAt,
    returnedAt: row.returnedAt,
    returned: row.returnedAt !== null || /return|rto/i.test(row.deliveryStatus),
    valuePaise: toPaise(row.value) ?? 0n,
    expectedPaise: toPaise(row.expected),
    freightExpectedPaise: toPaise(row.freightExpected),
    counts: {
      settlement: row.lineCounts.settlement ?? 0,
      codRemittance: row.lineCounts.codRemittance ?? 0,
      freight: row.lineCounts.freight ?? 0,
      returnScan: row.lineCounts.returnScan ?? 0,
    },
  }));
}

const byExpected = (a: CandidateOrder, b: CandidateOrder): number =>
  Number((a.expectedPaise ?? 0n) - (b.expectedPaise ?? 0n));

/**
 * Orders grouped by the partner a line of each kind would come from, sorted by expected amount, so
 * the rules look only at orders whose amount is near the line's amount.
 */
export class OrderIndex {
  private readonly byPartner = new Map<string, CandidateOrder[]>();
  private readonly returned: CandidateOrder[];
  private readonly byKey = new Map<string, CandidateOrder[]>();

  constructor(orders: readonly CandidateOrder[]) {
    const add = (key: string, order: CandidateOrder) => {
      const list = this.byPartner.get(key) ?? [];
      list.push(order);
      this.byPartner.set(key, list);
    };
    for (const order of orders) {
      add(`S:${order.channelId}`, order);
      if (order.courierId) add(`C:${order.courierId}`, order);
      else add("C:*", order);
      for (const key of [normaliseKey(order.orderId), order.awb ? normaliseKey(order.awb) : ""]) {
        if (!key) continue;
        const list = this.byKey.get(key) ?? [];
        list.push(order);
        this.byKey.set(key, list);
      }
    }
    for (const list of this.byPartner.values()) list.sort(byExpected);
    this.returned = orders.filter((order) => order.returned);
  }

  private readonly courierLists = new Map<string, CandidateOrder[]>();

  /** The orders of one courier plus those with no courier, as one list sorted by expected amount. */
  private courierList(courierId: string): CandidateOrder[] {
    let list = this.courierLists.get(courierId);
    if (!list) {
      // Two sorted lists put together are not sorted, and the search needs it to be.
      list = [
        ...(this.byPartner.get(`C:${courierId}`) ?? []),
        ...(this.byPartner.get("C:*") ?? []),
      ].sort(byExpected);
      this.courierLists.set(courierId, list);
    }
    return list;
  }

  /** Orders worth scoring for this line. */
  near(line: LineFacts): CandidateOrder[] {
    if (line.kind === "RETURN_SCAN") return this.returned;
    const list =
      line.kind === "SETTLEMENT"
        ? (this.byPartner.get(`S:${line.partnerId}`) ?? [])
        : this.courierList(line.partnerId);
    const chosen = new Set<CandidateOrder>();
    const target = line.amountPaise;
    if (target !== null && line.kind !== "FREIGHT") {
      // Expected amounts within 12% of the line amount (the rules accept up to 10%).
      const low = (target * 88n) / 100n;
      const high = (target * 112n) / 100n;
      let from = 0;
      let to = list.length;
      while (from < to) {
        const mid = (from + to) >> 1;
        if ((list[mid]?.expectedPaise ?? 0n) < low) from = mid + 1;
        else to = mid;
      }
      for (let i = from; i < list.length; i += 1) {
        const order = list[i];
        if (!order || (order.expectedPaise ?? 0n) > high) break;
        chosen.add(order);
      }
    } else if (target !== null) {
      // Freight: compare with the freight the rate card allows.
      const low = (target * 88n) / 100n;
      const high = (target * 112n) / 100n;
      for (const order of list) {
        const allowed = order.freightExpectedPaise;
        if (allowed !== null && absBig(allowed) >= absBig(low) && absBig(allowed) <= absBig(high)) {
          chosen.add(order);
        }
      }
    } else {
      for (const order of list) chosen.add(order);
    }
    // Orders the line's own ID or AWB points at, even if the amount is far off.
    for (const raw of [line.orderIdRaw, line.awb]) {
      if (raw) for (const order of this.byKey.get(normaliseKey(raw)) ?? []) chosen.add(order);
    }
    return [...chosen];
  }
}

function aiConfig(): AiConfig {
  return {
    provider: env.AI_PROVIDER,
    apiKey: env.AI_API_KEY,
    baseUrl: env.AI_BASE_URL,
    model: env.AI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
  };
}

interface Row {
  lineKind: LineKind;
  lineId: string;
  candidateOrderPk: string;
  score: number;
  reasons: string[];
  origin: "RULES" | "AI";
  aiModel: string | null;
  jobId: string;
}

/**
 * The SUGGEST_MATCHES job. Looks at every line that is still UNMATCHED and proposes up to three
 * orders for it by rules. Where the rules cannot tell the top two apart, the AI (if configured)
 * ranks them in batches. Everything is saved as PENDING: a person decides in the review queue.
 */
export function createSuggestHandler(prisma: PrismaClient): JobHandler {
  return async ({ job, setStage }) => {
    await setStage("preparing", 5);
    // Suggestions for lines that got matched meanwhile are obsolete.
    for (const [kind, table] of [
      ["SETTLEMENT", "settlement_lines"],
      ["COD_REMITTANCE", "cod_remittance_lines"],
      ["FREIGHT", "freight_lines"],
      ["RETURN_SCAN", "return_scans"],
    ] as const) {
      await prisma.$executeRawUnsafe(
        `UPDATE match_suggestions s SET status = 'SUPERSEDED'
         WHERE s.status = 'PENDING' AND s."lineKind" = '${kind}'::"LineKind"
           AND NOT EXISTS (SELECT 1 FROM ${table} l WHERE l.id = s."lineId" AND l."matchStatus" = 'UNMATCHED')`,
      );
    }

    const settings = await loadSettings(prisma);
    const rules: Rules = settings;
    const [lines, orders] = await Promise.all([loadUnmatchedLines(prisma), loadOrders(prisma)]);
    if (lines.length === 0 || orders.length === 0) {
      await setStage("finishing", 100);
      return;
    }

    await setStage("matching by rules", 30);
    const index = new OrderIndex(orders);
    const orderByPk = new Map(orders.map((order) => [order.pk, order]));
    const results = new Map<string, { line: LineFacts; candidates: Candidate[] }>();
    for (const line of lines) {
      const candidates = rankCandidates(line, index.near(line), rules);
      if (candidates.length > 0) results.set(`${line.kind}:${line.id}`, { line, candidates });
    }

    // The AI looks only at the ambiguous ones.
    const aiPicks = new Map<string, { index: number; reason: string; model: string }>();
    const config = aiConfig();
    const ambiguous = [...results.entries()].filter(([, entry]) => isAmbiguous(entry.candidates));
    if (config.provider !== "none" && ambiguous.length > 0) {
      await setStage("ranking with AI", 60);
      const cases: RankCase[] = ambiguous.slice(0, MAX_AI_LINES).map(([key, entry]) => ({
        key,
        kind: entry.line.kind,
        amount: entry.line.amountPaise === null ? null : paiseToAmount(entry.line.amountPaise),
        date: entry.line.date?.toISOString().slice(0, 10) ?? null,
        orderIdOnLine: entry.line.orderIdRaw,
        candidates: entry.candidates.map((candidate, i) => {
          const order = orderByPk.get(candidate.orderPk) as CandidateOrder;
          return {
            index: i,
            orderId: order.orderId,
            orderValue: paiseToAmount(order.valuePaise),
            expectedAmount:
              order.expectedPaise === null ? null : paiseToAmount(order.expectedPaise),
            orderDate: order.orderDate.toISOString().slice(0, 10),
            ruleScore: candidate.score,
          };
        }),
      }));
      try {
        for (const pick of await rankWithAi(config, cases)) {
          aiPicks.set(pick.key, { index: pick.index, reason: pick.reason, model: config.model });
        }
      } catch (err) {
        if (!(err instanceof AiUnavailableError)) throw err;
        logger.warn({ reason: err.message }, "AI ranking not available; the rules alone are used");
      }
    }

    const rows: Row[] = [];
    for (const [key, entry] of results) {
      const pick = aiPicks.get(key);
      entry.candidates.forEach((candidate, i) => {
        const chosen = pick?.index === i;
        rows.push({
          lineKind: entry.line.kind,
          lineId: entry.line.id,
          candidateOrderPk: candidate.orderPk,
          score: Math.min(100, candidate.score + (chosen ? 15 : 0)),
          reasons: chosen
            ? [
                ...candidate.reasons,
                `The AI ranked this order first${pick?.reason ? `: ${pick.reason}` : ""}`,
              ]
            : candidate.reasons,
          origin: chosen ? "AI" : "RULES",
          aiModel: chosen ? (pick?.model ?? null) : null,
          jobId: job.id,
        });
      });
    }

    await setStage("saving", 85);
    // A suggestion that already exists (pending, accepted or rejected) is left alone, so a
    // rejected one never comes back.
    for (let from = 0; from < rows.length; from += INSERT_BATCH) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO match_suggestions ("id", "lineKind", "lineId", "candidateOrderPk", "score", "reasons", "origin", "aiModel", "jobId")
         SELECT gen_random_uuid(), t."lineKind", t."lineId", t."candidateOrderPk", t."score", t."reasons", t."origin", t."aiModel", t."jobId"
         FROM jsonb_to_recordset($1::jsonb) AS t("lineKind" "LineKind", "lineId" uuid, "candidateOrderPk" uuid,
           "score" int, "reasons" jsonb, "origin" "SuggestionOrigin", "aiModel" text, "jobId" uuid)
         ON CONFLICT DO NOTHING`,
        JSON.stringify(rows.slice(from, from + INSERT_BATCH)),
      );
    }
    await setStage("finishing", 100);
  };
}
