import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { JobHandler } from "../../jobs/job-types.js";
import { pickRateCard, type CalcCard, type CalcRule } from "../rate-cards/expected-amount.js";
import { decimalToPaise, paiseToAmount } from "../rate-cards/money.js";
import { dataAsOf, linkLines, loadOrders, loadSettings } from "./matching.js";
import { isReturned, settleOrder } from "./settle.js";

const BATCH_SIZE = 5000;
const TRANSACTION_TIMEOUT_MS = 30 * 60 * 1000;

const amount = (value: bigint | null): string | null =>
  value === null ? null : paiseToAmount(value);

/**
 * The RECOMPUTE_RESULTS job: link lines to orders, work out every order's expected and received
 * amounts, and replace the order_results table in one transaction, so a screen never sees a
 * half-finished set. Rule-based; no AI.
 */
export function createRecomputeHandler(prisma: PrismaClient): JobHandler {
  return async ({ job, setStage }) => {
    await setStage("linking", 5);
    await linkLines(prisma);

    await setStage("calculating", 25);
    const [settings, asOf, orders, cards] = await Promise.all([
      loadSettings(prisma),
      dataAsOf(prisma),
      loadOrders(prisma),
      prisma.rateCard.findMany({ include: { rules: { orderBy: { sortOrder: "asc" } } } }),
    ]);

    // Fees as the calculator wants them: money in whole paise. Built once per card.
    const rulesByCard = new Map<string, CalcRule[]>(
      cards.map((card) => [
        card.id,
        card.rules.map((rule) => ({
          ruleType: rule.ruleType,
          minWeightGrams: rule.minWeightGrams,
          maxWeightGrams: rule.maxWeightGrams,
          basisPoints: rule.basisPoints,
          amountPaise: rule.amount === null ? null : decimalToPaise(rule.amount),
        })),
      ]),
    );
    const calcCards: CalcCard[] = cards;

    const rows = orders.map((order) => {
      const card = pickRateCard(calcCards, {
        channelSourceId: order.channelSourceId,
        courierSourceId: order.courierSourceId,
        orderDate: order.facts.orderDate,
      });
      const verdict = settleOrder(
        order.facts,
        order.aggregates,
        card ? (rulesByCard.get(card.id) ?? null) : null,
        asOf,
        settings,
      );
      const a = order.aggregates;
      return {
        orderPk: order.id,
        jobId: job.id,
        rateCardId: card?.id ?? null,
        rateCardVersionNo: card?.versionNo ?? null,
        expected: amount(verdict.expectedPaise),
        settlementNet: amount(a.settlementNet),
        tcs: amount(a.tcs),
        tds: amount(a.tds),
        codRemitted: amount(a.codRemitted),
        returnFreight: amount(a.reverseFreight),
        received: amount(verdict.receivedPaise),
        difference: amount(verdict.differencePaise),
        freightExpected: amount(verdict.freightExpectedPaise),
        freightBilled: amount(isReturned(order.facts) ? a.reverseFreight : a.forwardFreight),
        status: verdict.status,
        flags: verdict.flags,
        calcProblem: verdict.calcProblem,
        matchMethod: verdict.matched ? "EXACT" : "NONE",
        lineCounts: a.counts,
        dueDate: verdict.dueDate?.toISOString() ?? null,
        asOf: asOf.toISOString(),
      };
    });

    await setStage("saving", 55);
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM order_results`);
        for (let from = 0; from < rows.length; from += BATCH_SIZE) {
          const batch = rows.slice(from, from + BATCH_SIZE);
          await tx.$executeRawUnsafe(
            `INSERT INTO order_results ("id", "orderPk", "jobId", "rateCardId", "rateCardVersionNo", "expected",
               "settlementNet", "tcs", "tds", "codRemitted", "returnFreight", "received", "difference",
               "freightExpected", "freightBilled", "status", "flags", "calcProblem", "matchMethod", "lineCounts",
               "dueDate", "asOf")
             SELECT gen_random_uuid(), t."orderPk", t."jobId", t."rateCardId", t."rateCardVersionNo", t."expected",
               t."settlementNet", t."tcs", t."tds", t."codRemitted", t."returnFreight", t."received", t."difference",
               t."freightExpected", t."freightBilled", t."status", t."flags", t."calcProblem", t."matchMethod",
               t."lineCounts", t."dueDate", t."asOf"
             FROM jsonb_to_recordset($1::jsonb) AS t(
               "orderPk" uuid, "jobId" uuid, "rateCardId" uuid, "rateCardVersionNo" int, "expected" numeric(14,2),
               "settlementNet" numeric(14,2), "tcs" numeric(14,2), "tds" numeric(14,2), "codRemitted" numeric(14,2),
               "returnFreight" numeric(14,2), "received" numeric(14,2), "difference" numeric(14,2),
               "freightExpected" numeric(14,2), "freightBilled" numeric(14,2), "status" "OrderStatus",
               "flags" jsonb, "calcProblem" text, "matchMethod" "MatchMethod", "lineCounts" jsonb,
               "dueDate" timestamp(3), "asOf" timestamp(3))`,
            JSON.stringify(batch),
          );
          await setStage(
            "saving",
            55 + Math.round((Math.min(from + BATCH_SIZE, rows.length) / rows.length) * 40),
          );
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 60_000 },
    );
    await setStage("finishing", 100);
  };
}
