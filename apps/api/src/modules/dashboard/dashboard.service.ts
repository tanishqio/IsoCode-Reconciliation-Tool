import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import type { SourceKind } from "../../../generated/prisma/enums.js";
import { parseAmountToPaise, paiseToAmount } from "../rate-cards/money.js";
import { AGE_BUCKET_LIMITS, AGE_BUCKETS, type AgeBucket } from "./age-buckets.js";
import { monthStart } from "./dashboard.schemas.js";
import {
  isRiskStatus,
  partnerIdFor,
  RISK_STATUSES,
  type RiskStatus,
} from "./partner-attribution.js";

// Reads the results table (order_results, written by Part 6) and the settlement lines. Nothing here
// changes data. All money is added up as whole paise (BigInt) and sent as text ("1234.50").

export type DashboardService = ReturnType<typeof createDashboardService>;

interface RiskRow {
  status: string;
  paymentType: "COD" | "PREPAID";
  channelId: string;
  courierId: string | null;
  bucket: number;
  orders: number;
  amount: string;
}

interface TaxRow {
  partnerId: string;
  name: string;
  kind: SourceKind;
  lines: number;
  tcs: string;
  tds: string;
}

const textToPaise = (text: string): bigint => {
  const negative = text.startsWith("-");
  const paise = parseAmountToPaise(negative ? text.slice(1) : text);
  if (paise === null) throw new RangeError(`Not a money amount: ${text}`);
  return negative ? -paise : paise;
};

type CashType = Exclude<RiskStatus, "RETURN_NOT_RECEIVED">;

interface Tally {
  cash: bigint;
  cashOrders: number;
  byType: Record<CashType, { orders: number; amount: bigint }>;
  byAge: bigint[];
  byAgeOrders: number[];
  returnsOrders: number;
  returnsValue: bigint;
}

const emptyTally = (): Tally => ({
  cash: 0n,
  cashOrders: 0,
  byType: {
    SHORT_PAID: { orders: 0, amount: 0n },
    UNPAID_PAST_DUE: { orders: 0, amount: 0n },
    FREIGHT_OVERCHARGED: { orders: 0, amount: 0n },
  },
  byAge: AGE_BUCKETS.map(() => 0n),
  byAgeOrders: AGE_BUCKETS.map(() => 0),
  returnsOrders: 0,
  returnsValue: 0n,
});

function addRow(tally: Tally, status: RiskStatus, bucket: number, orders: number, amount: bigint) {
  if (status === "RETURN_NOT_RECEIVED") {
    tally.returnsOrders += orders;
    tally.returnsValue += amount;
    return;
  }
  tally.cash += amount;
  tally.cashOrders += orders;
  tally.byType[status].orders += orders;
  tally.byType[status].amount += amount;
  tally.byAge[bucket] = (tally.byAge[bucket] ?? 0n) + amount;
  tally.byAgeOrders[bucket] = (tally.byAgeOrders[bucket] ?? 0) + orders;
}

const money = (paise: bigint) => paiseToAmount(paise);

function tallyToDto(tally: Tally) {
  return {
    cashAtRisk: money(tally.cash),
    orders: tally.cashOrders,
    byType: {
      shortPaid: {
        orders: tally.byType.SHORT_PAID.orders,
        amount: money(tally.byType.SHORT_PAID.amount),
      },
      unpaidPastDue: {
        orders: tally.byType.UNPAID_PAST_DUE.orders,
        amount: money(tally.byType.UNPAID_PAST_DUE.amount),
      },
      freightOvercharged: {
        orders: tally.byType.FREIGHT_OVERCHARGED.orders,
        amount: money(tally.byType.FREIGHT_OVERCHARGED.amount),
      },
    },
    byAge: AGE_BUCKETS.map((bucket, index) => ({
      key: bucket.key,
      amount: money(tally.byAge[index] ?? 0n),
      orders: tally.byAgeOrders[index] ?? 0,
    })),
    returnsNotReceived: { orders: tally.returnsOrders, orderValue: money(tally.returnsValue) },
  };
}

export function createDashboardService({ prisma }: { prisma: PrismaClient }) {
  /** Orders that put money at risk, grouped by what went wrong, who owes it, and how old it is. */
  async function loadRiskRows(): Promise<RiskRow[]> {
    const [first, second, third] = AGE_BUCKET_LIMITS;
    return prisma.$queryRaw<RiskRow[]>(Prisma.sql`
      SELECT r.status::text AS status,
             o."paymentType"::text AS "paymentType",
             o."channelSourceId"::text AS "channelId",
             o."courierSourceId"::text AS "courierId",
             CASE WHEN age.days <= ${first} THEN 0
                  WHEN age.days <= ${second} THEN 1
                  WHEN age.days <= ${third} THEN 2
                  ELSE 3 END AS bucket,
             count(*)::int AS orders,
             COALESCE(sum(CASE r.status
               WHEN 'SHORT_PAID' THEN GREATEST(-COALESCE(r.difference, 0), 0)
               WHEN 'UNPAID_PAST_DUE' THEN GREATEST(-COALESCE(r.difference, 0), 0)
               WHEN 'FREIGHT_OVERCHARGED' THEN GREATEST(
                 COALESCE(r."freightBilled" - r."freightExpected", -COALESCE(r.difference, 0)), 0)
               ELSE o.value END), 0)::text AS amount
      FROM order_results r
      JOIN customer_orders o ON o.id = r."orderPk"
      CROSS JOIN LATERAL (
        SELECT GREATEST(0, (r."asOf"::date - COALESCE(r."dueDate", o."deliveredAt", o."orderDate")::date)) AS days
      ) age
      WHERE r.status IN ('SHORT_PAID', 'UNPAID_PAST_DUE', 'FREIGHT_OVERCHARGED', 'RETURN_NOT_RECEIVED')
      GROUP BY 1, 2, 3, 4, 5`);
  }

  async function moneyAtRisk() {
    const [rows, statusCounts, latest, settings] = await Promise.all([
      loadRiskRows(),
      prisma.orderResult.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.orderResult.findFirst({
        orderBy: { computedAt: "desc" },
        select: { computedAt: true, asOf: true },
      }),
      prisma.reconciliationSettings.findUnique({
        where: { id: 1 },
        select: { isSampleData: true },
      }),
    ]);

    const total = emptyTally();
    const byPartner = new Map<string, Tally>();
    for (const row of rows) {
      if (!isRiskStatus(row.status)) continue;
      const partnerId = partnerIdFor({
        status: row.status,
        paymentType: row.paymentType,
        channelId: row.channelId,
        courierId: row.courierId,
      });
      const amount = textToPaise(row.amount);
      const tally = byPartner.get(partnerId) ?? emptyTally();
      byPartner.set(partnerId, tally);
      addRow(tally, row.status, row.bucket, row.orders, amount);
      addRow(total, row.status, row.bucket, row.orders, amount);
    }

    const sources = byPartner.size
      ? await prisma.source.findMany({
          where: { id: { in: [...byPartner.keys()] } },
          select: { id: true, name: true, kind: true },
        })
      : [];
    const sourceById = new Map(sources.map((source) => [source.id, source]));

    // Biggest cash at risk first; partners with the same amount are listed by name.
    const partners = [...byPartner.entries()]
      .map(([id, tally]) => ({
        id,
        name: sourceById.get(id)?.name ?? "Unknown partner",
        tally,
      }))
      .sort((a, b) =>
        a.tally.cash === b.tally.cash
          ? a.name.localeCompare(b.name)
          : a.tally.cash > b.tally.cash
            ? -1
            : 1,
      )
      .map(({ id, name, tally }) => ({
        id,
        name,
        kind: sourceById.get(id)?.kind ?? null,
        ...tallyToDto(tally),
      }));

    const count = (status: string) =>
      statusCounts.find((entry) => entry.status === status)?._count._all ?? 0;
    const resultCount = statusCounts.reduce((sum, entry) => sum + entry._count._all, 0);

    return {
      hasResults: resultCount > 0,
      asOf: latest?.asOf.toISOString() ?? null,
      computedAt: latest?.computedAt.toISOString() ?? null,
      settingsAreSample: settings?.isSampleData ?? true,
      ageBuckets: AGE_BUCKETS.map((bucket: AgeBucket) => ({ ...bucket })),
      statuses: [...RISK_STATUSES],
      totals: tallyToDto(total),
      partners,
      notIncluded: {
        pending: count("PENDING"),
        cannotCalculate: count("CANNOT_CALCULATE"),
        notTracked: count("NOT_TRACKED"),
        overpaid: count("OVERPAID"),
        settled: count("SETTLED"),
      },
      orderCount: resultCount,
    };
  }

  /** GST TCS and income tax TDS withheld by each partner, from the settlement lines. */
  async function taxSummary(month?: string) {
    const start = month ? monthStart(month) : null;
    const [rows, monthRows] = await Promise.all([
      prisma.$queryRaw<TaxRow[]>(Prisma.sql`
        SELECT s.id::text AS "partnerId", s.name, s.kind::text AS kind, count(*)::int AS lines,
               COALESCE(sum(l.tcs), 0)::text AS tcs, COALESCE(sum(l.tds), 0)::text AS tds
        FROM settlement_lines l
        JOIN sources s ON s.id = l."sourceId"
        WHERE (${start}::date IS NULL
               OR (l."settledOn" >= ${start}::date AND l."settledOn" < (${start}::date + interval '1 month')))
        GROUP BY s.id, s.name, s.kind
        ORDER BY s.name`),
      prisma.$queryRaw<{ month: string }[]>(Prisma.sql`
        SELECT to_char(date_trunc('month', "settledOn"), 'YYYY-MM') AS month
        FROM settlement_lines GROUP BY 1 ORDER BY 1 DESC`),
    ]);

    let totalLines = 0;
    let totalTcs = 0n;
    let totalTds = 0n;
    const partners = rows.map((row) => {
      const tcs = textToPaise(row.tcs);
      const tds = textToPaise(row.tds);
      totalLines += row.lines;
      totalTcs += tcs;
      totalTds += tds;
      return {
        id: row.partnerId,
        name: row.name,
        kind: row.kind,
        lines: row.lines,
        tcs: money(tcs),
        tds: money(tds),
        total: money(tcs + tds),
      };
    });

    return {
      month: month ?? null,
      months: monthRows.map((row) => row.month),
      partners,
      totals: {
        lines: totalLines,
        tcs: money(totalTcs),
        tds: money(totalTds),
        total: money(totalTcs + totalTds),
      },
    };
  }

  return { moneyAtRisk, taxSummary };
}
