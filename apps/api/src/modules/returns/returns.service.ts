import { z } from "zod";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { loadSettings } from "../reconciliation/matching.js";

// The returns tracker: every returned order against the warehouse receipt scans. Read only.
//
// ASSUMPTION (same rule as the order results, T35): a returned order is one whose delivery status
// mentions a return or that has a return date. It is RECEIVED when a warehouse scan is matched to
// it, NOT_RECEIVED when there is none after the return window, and WAITING before that. The window
// starts at the return date (or the delivery date, then the order date, when the file has none) and
// is judged against the newest date in the uploaded data.

export const returnsQuerySchema = z.object({
  state: z.enum(["RECEIVED", "NOT_RECEIVED", "WAITING"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type ReturnsQuery = z.infer<typeof returnsQuerySchema>;

interface ReturnRow {
  id: string;
  orderId: string;
  channel: string;
  courier: string | null;
  awb: string | null;
  value: string;
  deliveryStatus: string;
  returnedAt: Date | null;
  returnStart: Date;
  windowEnds: Date;
  daysSince: number;
  scannedAt: Date | null;
  state: "RECEIVED" | "NOT_RECEIVED" | "WAITING";
}

export type ReturnsService = ReturnType<typeof createReturnsService>;

export function createReturnsService({ prisma }: { prisma: PrismaClient }) {
  /** The returned orders with their state, as a sub-query shared by the list and the summary. */
  async function base(extraWhere: Prisma.Sql) {
    const settings = await loadSettings(prisma);
    const days = settings.returnWindowDays;
    return {
      days,
      sql: Prisma.sql`
        SELECT o.id::text AS id, o."orderId", ch.name AS channel, co.name AS courier, o.awb,
               o.value::text AS value, o."deliveryStatus", o."returnedAt",
               COALESCE(o."returnedAt", o."deliveredAt", o."orderDate") AS "returnStart",
               COALESCE(o."returnedAt", o."deliveredAt", o."orderDate") + (${days} * interval '1 day') AS "windowEnds",
               GREATEST(0, (r."asOf"::date - COALESCE(o."returnedAt", o."deliveredAt", o."orderDate")::date))::int AS "daysSince",
               sc."scannedAt",
               CASE WHEN sc.n > 0 THEN 'RECEIVED'
                    WHEN r."asOf" > COALESCE(o."returnedAt", o."deliveredAt", o."orderDate") + (${days} * interval '1 day')
                      THEN 'NOT_RECEIVED'
                    ELSE 'WAITING' END AS state
        FROM customer_orders o
        JOIN order_results r ON r."orderPk" = o.id
        JOIN sources ch ON ch.id = o."channelSourceId"
        LEFT JOIN sources co ON co.id = o."courierSourceId"
        LEFT JOIN LATERAL (
          SELECT min("scannedAt") AS "scannedAt", count(*) AS n FROM return_scans WHERE "orderPk" = o.id
        ) sc ON true
        WHERE (o."returnedAt" IS NOT NULL OR o."deliveryStatus" ~* 'return|rto') ${extraWhere}`,
    };
  }

  async function summary() {
    const { sql, days } = await base(Prisma.empty);
    const [rows, latest] = await Promise.all([
      prisma.$queryRaw<{ state: string; orders: number; value: string }[]>(Prisma.sql`
        SELECT state, count(*)::int AS orders, COALESCE(sum(value::numeric), 0)::text AS value
        FROM (${sql}) t GROUP BY state`),
      prisma.orderResult.findFirst({ orderBy: { computedAt: "desc" }, select: { asOf: true } }),
    ]);
    const pick = (state: string) => {
      const row = rows.find((entry) => entry.state === state);
      return { orders: row?.orders ?? 0, value: row ? Number(row.value).toFixed(2) : "0.00" };
    };
    return {
      windowDays: days,
      asOf: latest?.asOf.toISOString() ?? null,
      notReceived: pick("NOT_RECEIVED"),
      waiting: pick("WAITING"),
      received: pick("RECEIVED"),
    };
  }

  async function list(query: ReturnsQuery) {
    const filters = Prisma.sql`${
      query.q
        ? Prisma.sql`AND o."orderId" ILIKE ${`%${query.q.replace(/[%_\\]/g, "\\$&")}%`}`
        : Prisma.empty
    }`;
    const { sql, days } = await base(filters);
    const stateFilter = query.state ? Prisma.sql`WHERE t.state = ${query.state}` : Prisma.empty;
    const offset = (query.page - 1) * query.pageSize;
    const [rows, count] = await Promise.all([
      prisma.$queryRaw<ReturnRow[]>(Prisma.sql`
        SELECT * FROM (${sql}) t ${stateFilter}
        ORDER BY (CASE t.state WHEN 'NOT_RECEIVED' THEN 0 WHEN 'WAITING' THEN 1 ELSE 2 END),
                 t."daysSince" DESC, t.id
        LIMIT ${query.pageSize} OFFSET ${offset}`),
      prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
        SELECT count(*)::int AS n FROM (${sql}) t ${stateFilter}`),
    ]);
    return {
      windowDays: days,
      total: count[0]?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      items: rows.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        channel: row.channel,
        courier: row.courier,
        awb: row.awb,
        value: Number(row.value).toFixed(2),
        deliveryStatus: row.deliveryStatus,
        returnedAt: row.returnedAt?.toISOString() ?? null,
        returnStart: row.returnStart.toISOString(),
        windowEnds: row.windowEnds.toISOString(),
        daysSince: row.daysSince,
        scannedAt: row.scannedAt?.toISOString() ?? null,
        state: row.state,
      })),
    };
  }

  return { summary, list };
}
