import type { Prisma, PrismaClient } from "../../../generated/prisma/client.js";
import type { ClaimType, OrderStatus, PaymentType } from "../../../generated/prisma/enums.js";
import type { JobHandler } from "../../jobs/job-types.js";
import { ageInDays } from "../dashboard/age-buckets.js";
import { partnerIdFor, isRiskStatus } from "../dashboard/partner-attribution.js";
import { paiseToAmount, parseAmountToPaise } from "../rate-cards/money.js";
import { claimFor, CLAIMABLE_STATUSES } from "./claim-rules.js";
import { buildEvidence } from "./evidence.js";

const INSERT_BATCH = 500;

interface ProblemRow {
  orderPk: string;
  status: OrderStatus;
  paymentType: PaymentType;
  channelId: string;
  courierId: string | null;
  value: string;
  difference: string | null;
  freightBilled: string;
  freightExpected: string | null;
  dueDate: Date | null;
  deliveredAt: Date | null;
  orderDate: Date;
  asOf: Date;
}

const toPaise = (text: string): bigint => {
  const negative = text.startsWith("-");
  const value = parseAmountToPaise(negative ? text.slice(1) : text);
  if (value === null) throw new RangeError(`Not a money amount: ${text}`);
  return negative ? -value : value;
};

interface Planned {
  orderPk: string;
  partnerId: string;
  type: ClaimType;
  amount: bigint;
  basis: Date;
  ageDays: number;
}

/**
 * The BUILD_CLAIMS job. Turns the problem orders of the results table into claims, one open claim
 * per partner. An order already inside an exported, recovered or closed claim is never claimed
 * again. Items of open claims are rebuilt from the current results, so a claim always shows what
 * is wrong now; an order that has been paid since drops out. Open claims left empty are removed.
 */
export function createBuildClaimsHandler(prisma: PrismaClient): JobHandler {
  return async ({ setStage }) => {
    await setStage("collecting problem orders", 10);
    const statusList = CLAIMABLE_STATUSES.map((status) => `'${status}'`).join(", ");
    const rows = await prisma.$queryRawUnsafe<ProblemRow[]>(`
      SELECT r."orderPk"::text AS "orderPk", r.status, o."paymentType", o."channelSourceId"::text AS "channelId",
             o."courierSourceId"::text AS "courierId", o.value::text AS value, r.difference::text AS difference,
             r."freightBilled"::text AS "freightBilled", r."freightExpected"::text AS "freightExpected",
             r."dueDate", o."deliveredAt", o."orderDate", r."asOf"
      FROM order_results r JOIN customer_orders o ON o.id = r."orderPk"
      WHERE r.status IN (${statusList})`);

    // Orders already inside a claim that is no longer open are not claimed again.
    const frozen = await prisma.claimItem.findMany({
      where: { claim: { status: { not: "OPEN" } } },
      select: { orderPk: true, claimType: true },
    });
    const frozenKeys = new Set(frozen.map((item) => `${item.orderPk}:${item.claimType}`));

    const planned: Planned[] = [];
    for (const row of rows) {
      if (!isRiskStatus(row.status)) continue;
      const claim = claimFor({
        status: row.status,
        differencePaise: row.difference === null ? null : toPaise(row.difference),
        freightBilledPaise: toPaise(row.freightBilled),
        freightExpectedPaise: row.freightExpected === null ? null : toPaise(row.freightExpected),
        orderValuePaise: toPaise(row.value),
      });
      if (!claim || frozenKeys.has(`${row.orderPk}:${claim.type}`)) continue;
      const basis = row.dueDate ?? row.deliveredAt ?? row.orderDate;
      planned.push({
        orderPk: row.orderPk,
        partnerId: partnerIdFor({
          status: row.status,
          paymentType: row.paymentType,
          channelId: row.channelId,
          courierId: row.courierId,
        }),
        type: claim.type,
        amount: claim.amountPaise,
        basis,
        ageDays: ageInDays(row.asOf, basis),
      });
    }

    await setStage("building the evidence", 35);
    const evidence = await buildEvidence(
      prisma,
      planned.map((item) => item.orderPk),
    );

    await setStage("saving claims", 70);
    await prisma.$transaction(
      async (tx) => {
        // Open claims are rebuilt from scratch; their items are replaced below.
        await tx.claimItem.deleteMany({ where: { claim: { status: "OPEN" } } });

        const openByPartner = new Map(
          (
            await tx.claim.findMany({
              where: { status: "OPEN" },
              select: { id: true, partnerSourceId: true },
            })
          ).map((claim) => [claim.partnerSourceId, claim.id]),
        );
        for (const partnerId of new Set(planned.map((item) => item.partnerId))) {
          if (!openByPartner.has(partnerId)) {
            const created = await tx.claim.create({
              data: { partnerSourceId: partnerId },
              select: { id: true },
            });
            openByPartner.set(partnerId, created.id);
          }
        }

        for (let from = 0; from < planned.length; from += INSERT_BATCH) {
          await tx.claimItem.createMany({
            data: planned.slice(from, from + INSERT_BATCH).map((item) => ({
              claimId: openByPartner.get(item.partnerId) as string,
              orderPk: item.orderPk,
              claimType: item.type,
              amount: paiseToAmount(item.amount),
              ageBasisDate: item.basis,
              ageDays: item.ageDays,
              evidence: (evidence.get(item.orderPk) ?? {}) as unknown as Prisma.InputJsonValue,
            })),
          });
        }

        // Totals of every open claim, then drop the open claims that ended up empty.
        await tx.$executeRawUnsafe(`
          UPDATE claims c SET
            "itemCount" = COALESCE(s.n, 0), total = COALESCE(s.total, 0), "updatedAt" = now() AT TIME ZONE 'UTC'
          FROM claims c2
          LEFT JOIN (SELECT "claimId", count(*)::int AS n, sum(amount) AS total FROM claim_items GROUP BY "claimId") s
            ON s."claimId" = c2.id
          WHERE c.id = c2.id AND c.status = 'OPEN'`);
        await tx.claim.deleteMany({ where: { status: "OPEN", itemCount: 0 } });
      },
      { timeout: 10 * 60 * 1000, maxWait: 60_000 },
    );
    await setStage("finishing", 100);
  };
}
