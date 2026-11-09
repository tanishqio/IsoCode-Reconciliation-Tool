import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { PaymentType, SourceKind } from "../../../generated/prisma/enums.js";
import { decimalToPaise, parseAmountToPaise } from "../rate-cards/money.js";
import type { Aggregates, OrderFacts, Settings } from "./settle.js";

// Exact matching by order ID or AWB, done inside PostgreSQL as set-based statements. No guessing:
// a line is linked only when the key points at exactly one order. Lines that stay UNMATCHED
// (no ID, an unknown ID, or an ID shared by several orders) are left for the review queue (Part 8).
// Lines already linked (EXACT) or accepted by a person (ACCEPTED) are never changed here.

/** Links unmatched lines to orders. Returns how many lines were linked in this run. */
export async function linkLines(prisma: PrismaClient): Promise<number> {
  let linked = 0;
  // Settlement lines belong to a channel, and (channel, order ID) is unique.
  linked += await prisma.$executeRawUnsafe(`
    UPDATE settlement_lines l SET "orderPk" = o.id, "matchStatus" = 'EXACT'
    FROM customer_orders o
    WHERE l."matchStatus" = 'UNMATCHED' AND l."orderIdRaw" IS NOT NULL
      AND o."channelSourceId" = l."sourceId" AND o."orderId" = l."orderIdRaw"`);

  // The other files come from aggregators and the warehouse, so the order ID must be unique
  // across channels to be trusted; the AWB must be unique too.
  for (const table of ["cod_remittance_lines", "freight_lines", "return_scans"]) {
    linked += await prisma.$executeRawUnsafe(`
      WITH u AS (
        SELECT "orderId", (array_agg(id))[1] AS id FROM customer_orders GROUP BY "orderId" HAVING count(*) = 1
      )
      UPDATE ${table} l SET "orderPk" = u.id, "matchStatus" = 'EXACT'
      FROM u WHERE l."matchStatus" = 'UNMATCHED' AND l."orderIdRaw" = u."orderId"`);
    linked += await prisma.$executeRawUnsafe(`
      WITH u AS (
        SELECT awb, (array_agg(id))[1] AS id FROM customer_orders WHERE awb IS NOT NULL GROUP BY awb HAVING count(*) = 1
      )
      UPDATE ${table} l SET "orderPk" = u.id, "matchStatus" = 'EXACT'
      FROM u WHERE l."matchStatus" = 'UNMATCHED' AND l.awb = u.awb`);
  }
  return linked;
}

/** The newest date in the uploaded data. "Late" is judged against this, not against today. */
export async function dataAsOf(prisma: PrismaClient): Promise<Date> {
  const rows = await prisma.$queryRawUnsafe<{ asof: Date | null }[]>(`
    SELECT greatest(
      (SELECT max(greatest("orderDate", "deliveredAt", "returnedAt")) FROM customer_orders),
      (SELECT max("settledOn") FROM settlement_lines),
      (SELECT max("remittedOn") FROM cod_remittance_lines),
      (SELECT max("chargedOn") FROM freight_lines),
      (SELECT max("scannedAt") FROM return_scans)
    ) AS asof`);
  return rows[0]?.asof ?? new Date();
}

export interface OrderRow {
  id: string;
  channelSourceId: string;
  courierSourceId: string | null;
  facts: OrderFacts;
  aggregates: Aggregates;
}

interface RawOrderRow {
  id: string;
  channelSourceId: string;
  courierSourceId: string | null;
  channelKind: SourceKind;
  paymentType: PaymentType;
  deliveryStatus: string;
  orderDate: Date;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  weightGrams: number | null;
  value: string;
  settlementNet: string;
  tcs: string;
  tds: string;
  settlementCount: number;
  codRemitted: string;
  codCount: number;
  forwardFreight: string;
  reverseFreight: string;
  freightCount: number;
  scanCount: number;
}

const paise = (text: string): bigint => {
  const negative = text.startsWith("-");
  const value = parseAmountToPaise(negative ? text.slice(1) : text);
  if (value === null) throw new RangeError(`Not a money amount: ${text}`);
  return negative ? -value : value;
};

/** Every order with the sums of its linked lines, in one query. */
export async function loadOrders(prisma: PrismaClient): Promise<OrderRow[]> {
  const rows = await prisma.$queryRawUnsafe<RawOrderRow[]>(`
    SELECT o.id, o."channelSourceId", o."courierSourceId", s.kind AS "channelKind", o."paymentType",
           o."deliveryStatus", o."orderDate", o."deliveredAt", o."returnedAt", o."weightGrams",
           o.value::text AS value,
           COALESCE(st.net, 0)::text AS "settlementNet", COALESCE(st.tcs, 0)::text AS tcs,
           COALESCE(st.tds, 0)::text AS tds, COALESCE(st.n, 0)::int AS "settlementCount",
           COALESCE(cd.amount, 0)::text AS "codRemitted", COALESCE(cd.n, 0)::int AS "codCount",
           COALESCE(fr.forward, 0)::text AS "forwardFreight", COALESCE(fr.reverse, 0)::text AS "reverseFreight",
           COALESCE(fr.n, 0)::int AS "freightCount", COALESCE(sc.n, 0)::int AS "scanCount"
    FROM customer_orders o
    JOIN sources s ON s.id = o."channelSourceId"
    LEFT JOIN (SELECT "orderPk", sum("netReceived") AS net, sum(tcs) AS tcs, sum(tds) AS tds, count(*) AS n
               FROM settlement_lines WHERE "orderPk" IS NOT NULL GROUP BY "orderPk") st ON st."orderPk" = o.id
    LEFT JOIN (SELECT "orderPk", sum("remittedAmount") AS amount, count(*) AS n
               FROM cod_remittance_lines WHERE "orderPk" IS NOT NULL GROUP BY "orderPk") cd ON cd."orderPk" = o.id
    LEFT JOIN (SELECT "orderPk",
                      sum("billedAmount") FILTER (WHERE "chargeType" IN ('FORWARD', 'OTHER')) AS forward,
                      sum("billedAmount") FILTER (WHERE "chargeType" = 'REVERSE') AS reverse,
                      count(*) AS n
               FROM freight_lines WHERE "orderPk" IS NOT NULL GROUP BY "orderPk") fr ON fr."orderPk" = o.id
    LEFT JOIN (SELECT "orderPk", count(*) AS n FROM return_scans WHERE "orderPk" IS NOT NULL GROUP BY "orderPk") sc
           ON sc."orderPk" = o.id
    ORDER BY o.id`);

  return rows.map((row) => ({
    id: row.id,
    channelSourceId: row.channelSourceId,
    courierSourceId: row.courierSourceId,
    facts: {
      paymentType: row.paymentType,
      channelKind: row.channelKind,
      deliveryStatus: row.deliveryStatus,
      orderDate: row.orderDate,
      deliveredAt: row.deliveredAt,
      returnedAt: row.returnedAt,
      weightGrams: row.weightGrams,
      valuePaise: paise(row.value),
    },
    aggregates: {
      settlementNet: paise(row.settlementNet),
      tcs: paise(row.tcs),
      tds: paise(row.tds),
      codRemitted: paise(row.codRemitted),
      forwardFreight: paise(row.forwardFreight),
      reverseFreight: paise(row.reverseFreight),
      counts: {
        settlement: row.settlementCount,
        codRemittance: row.codCount,
        freight: row.freightCount,
        returnScan: row.scanCount,
      },
    },
  }));
}

/** The settings row, created with its sample defaults if it does not exist yet. */
export async function loadSettings(
  prisma: PrismaClient,
): Promise<Settings & { isSampleData: boolean }> {
  const row = await prisma.reconciliationSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
  return {
    tolerancePaise: decimalToPaise(row.tolerance),
    codDueDays: row.codDueDays,
    settlementDueDays: row.settlementDueDays,
    returnWindowDays: row.returnWindowDays,
    isSampleData: row.isSampleData,
  };
}
