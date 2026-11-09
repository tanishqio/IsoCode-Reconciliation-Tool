import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { OrderStatus } from "../../../generated/prisma/enums.js";
import { AppError } from "../../lib/errors.js";
import { computeExpected, linesToAmounts, type CalcRule } from "../rate-cards/expected-amount.js";
import { decimalToPaise, paiseToAmount } from "../rate-cards/money.js";
import { loadSettings } from "./matching.js";
import { isReturned } from "./settle.js";

export const listOrdersQuerySchema = z.object({
  status: z.enum(OrderStatus).optional(),
  channelId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(["difference", "orderDate"]).default("difference"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const orderIdParamSchema = z.strictObject({ id: z.uuid() });

const money = (value: { toFixed(digits: number): string } | null): string | null =>
  value === null ? null : value.toFixed(2);

export type ReconciliationService = ReturnType<typeof createReconciliationService>;

/** Queues a background job of this type unless one of the same type is already waiting. */
export async function enqueueJob(
  prisma: PrismaClient,
  type: "RECOMPUTE_RESULTS" | "SUGGEST_MATCHES" | "BUILD_CLAIMS",
  userId: string,
  entityType: string,
): Promise<{ jobId: string; alreadyQueued: boolean }> {
  const waiting = await prisma.processingJob.findFirst({
    where: { type, status: "QUEUED" },
    select: { id: true },
  });
  if (waiting) return { jobId: waiting.id, alreadyQueued: true };
  const job = await prisma.processingJob.create({
    data: { type, entityType, createdById: userId },
    select: { id: true },
  });
  return { jobId: job.id, alreadyQueued: false };
}

/** Queues a recalculation unless one is already waiting. Safe to call after every change. */
export const enqueueRecompute = (prisma: PrismaClient, userId: string) =>
  enqueueJob(prisma, "RECOMPUTE_RESULTS", userId, "ORDER_RESULTS");
export function createReconciliationService({ prisma }: { prisma: PrismaClient }) {
  async function status() {
    const [job, latest, total, settings] = await Promise.all([
      prisma.processingJob.findFirst({
        where: { type: "RECOMPUTE_RESULTS" },
        orderBy: { queuedAt: "desc" },
        select: {
          status: true,
          stage: true,
          progressPct: true,
          errorMessage: true,
          queuedAt: true,
          finishedAt: true,
          stageTimingsMs: true,
        },
      }),
      prisma.orderResult.findFirst({
        orderBy: { computedAt: "desc" },
        select: { computedAt: true, asOf: true },
      }),
      prisma.orderResult.count(),
      loadSettings(prisma),
    ]);
    return {
      job: job
        ? {
            status: job.status,
            stage: job.stage,
            progressPct: job.progressPct,
            errorMessage: job.errorMessage,
            finishedAt: job.finishedAt?.toISOString() ?? null,
          }
        : null,
      computedAt: latest?.computedAt.toISOString() ?? null,
      asOf: latest?.asOf.toISOString() ?? null,
      orderCount: total,
      settings: {
        tolerance: paiseToAmount(settings.tolerancePaise),
        codDueDays: settings.codDueDays,
        settlementDueDays: settings.settlementDueDays,
        returnWindowDays: settings.returnWindowDays,
        isSampleData: settings.isSampleData,
      },
    };
  }

  async function summary() {
    const [groups, matched, channels] = await Promise.all([
      prisma.orderResult.groupBy({
        by: ["status"],
        _count: { _all: true },
        _sum: { difference: true },
      }),
      prisma.orderResult.count({ where: { matchMethod: "EXACT" } }),
      // For the channel filter. The co-founder cannot read /api/sources, so they come with the summary.
      prisma.source.findMany({
        where: { kind: { in: ["WEBSITE", "MARKETPLACE", "QUICK_COMMERCE"] }, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);
    const byStatus: Record<string, { count: number; difference: string }> = {};
    let total = 0;
    for (const group of groups) {
      byStatus[group.status] = {
        count: group._count._all,
        difference: money(group._sum.difference) ?? "0.00",
      };
      total += group._count._all;
    }
    return { total, matched, byStatus, channels };
  }

  async function list(query: ListOrdersQuery) {
    const where = {
      status: query.status,
      order: {
        channelSourceId: query.channelId,
        ...(query.q ? { orderId: { contains: query.q, mode: "insensitive" as const } } : {}),
      },
    };
    const [total, rows] = await Promise.all([
      prisma.orderResult.count({ where }),
      prisma.orderResult.findMany({
        where,
        orderBy:
          query.sort === "difference"
            ? [{ difference: { sort: "asc", nulls: "last" } }, { id: "asc" }]
            : [{ order: { orderDate: "desc" } }, { id: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          order: {
            include: { channel: { select: { name: true } }, courier: { select: { name: true } } },
          },
        },
      }),
    ]);
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: rows.map((row) => ({
        id: row.orderPk,
        orderId: row.order.orderId,
        channel: row.order.channel.name,
        courier: row.order.courier?.name ?? null,
        orderDate: row.order.orderDate.toISOString(),
        value: money(row.order.value) as string,
        paymentType: row.order.paymentType,
        deliveryStatus: row.order.deliveryStatus,
        expected: money(row.expected),
        received: money(row.received),
        difference: money(row.difference),
        status: row.status,
        flags: row.flags as string[],
      })),
    };
  }

  async function detail(orderPk: string) {
    const row = await prisma.orderResult.findUnique({
      where: { orderPk },
      include: {
        order: {
          include: { channel: { select: { name: true } }, courier: { select: { name: true } } },
        },
      },
    });
    if (!row) throw new AppError("NOT_FOUND", 404, "No result for that order yet.");

    const [settlement, cod, freight, scans, card] = await Promise.all([
      prisma.settlementLine.findMany({
        where: { orderPk },
        include: {
          sourceFile: { select: { originalName: true } },
          source: { select: { name: true } },
        },
        orderBy: { settledOn: "asc" },
      }),
      prisma.codRemittanceLine.findMany({
        where: { orderPk },
        include: {
          sourceFile: { select: { originalName: true } },
          aggregator: { select: { name: true } },
        },
        orderBy: { remittedOn: "asc" },
      }),
      prisma.freightLine.findMany({
        where: { orderPk },
        include: {
          sourceFile: { select: { originalName: true } },
          aggregator: { select: { name: true } },
        },
        orderBy: { chargedOn: "asc" },
      }),
      prisma.returnScan.findMany({
        where: { orderPk },
        include: { sourceFile: { select: { originalName: true } } },
        orderBy: { scannedAt: "asc" },
      }),
      row.rateCardId
        ? prisma.rateCard.findUnique({
            where: { id: row.rateCardId },
            include: { rules: { orderBy: { sortOrder: "asc" } } },
          })
        : Promise.resolve(null),
    ]);

    // The working of the expected amount, line by line, from the card that was used.
    let working: { label: string; amount: string }[] = [];
    if (card) {
      const rules: CalcRule[] = card.rules.map((rule) => ({
        ruleType: rule.ruleType,
        minWeightGrams: rule.minWeightGrams,
        maxWeightGrams: rule.maxWeightGrams,
        basisPoints: rule.basisPoints,
        amountPaise: rule.amount === null ? null : decimalToPaise(rule.amount),
      }));
      const calc = computeExpected(rules, {
        orderValuePaise: decimalToPaise(row.order.value),
        paymentType: row.order.paymentType,
        weightGrams: row.order.weightGrams,
        isReturn: isReturned(row.order),
      });
      if (calc.ok) working = linesToAmounts(calc.lines);
    }

    // How "received" was put together, so the person can see what counted and from which file.
    const received: { label: string; amount: string }[] = [];
    const push = (label: string, value: { toFixed(digits: number): string }, negate = false) => {
      const paise = decimalToPaise(value);
      if (paise !== 0n) received.push({ label, amount: paiseToAmount(negate ? -paise : paise) });
    };
    push("Settlement payout (net)", row.settlementNet);
    push("GST TCS withheld (added back)", row.tcs);
    push("Income tax TDS withheld (added back)", row.tds);
    push("COD remittance", row.codRemitted);
    if (isReturned(row.order)) push("Return freight billed (deducted)", row.returnFreight, true);

    return {
      order: {
        id: row.orderPk,
        orderId: row.order.orderId,
        channel: row.order.channel.name,
        courier: row.order.courier?.name ?? null,
        orderDate: row.order.orderDate.toISOString(),
        deliveredAt: row.order.deliveredAt?.toISOString() ?? null,
        returnedAt: row.order.returnedAt?.toISOString() ?? null,
        value: money(row.order.value) as string,
        paymentType: row.order.paymentType,
        deliveryStatus: row.order.deliveryStatus,
        awb: row.order.awb,
        weightGrams: row.order.weightGrams,
      },
      result: {
        status: row.status,
        flags: row.flags as string[],
        calcProblem: row.calcProblem,
        expected: money(row.expected),
        received: money(row.received),
        difference: money(row.difference),
        freightExpected: money(row.freightExpected),
        freightBilled: money(row.freightBilled),
        rateCard: card
          ? { id: card.id, versionNo: card.versionNo, isSampleData: card.isSampleData }
          : null,
        dueDate: row.dueDate?.toISOString() ?? null,
        asOf: row.asOf.toISOString(),
        computedAt: row.computedAt.toISOString(),
        matchMethod: row.matchMethod,
      },
      working,
      received,
      lines: {
        settlement: settlement.map((line) => ({
          id: line.id,
          partner: line.source.name,
          date: line.settledOn.toISOString(),
          type: line.lineType,
          amount: money(line.netReceived) as string,
          tcs: money(line.tcs) as string,
          tds: money(line.tds) as string,
          file: line.sourceFile.originalName,
          row: line.sourceRowNumber,
        })),
        codRemittance: cod.map((line) => ({
          id: line.id,
          partner: line.aggregator.name,
          date: line.remittedOn.toISOString(),
          reference: line.remittanceRef,
          amount: money(line.remittedAmount) as string,
          file: line.sourceFile.originalName,
          row: line.sourceRowNumber,
        })),
        freight: freight.map((line) => ({
          id: line.id,
          partner: line.aggregator.name,
          date: line.chargedOn?.toISOString() ?? null,
          invoiceNo: line.invoiceNo,
          chargeType: line.chargeType,
          amount: money(line.billedAmount) as string,
          file: line.sourceFile.originalName,
          row: line.sourceRowNumber,
        })),
        returnScans: scans.map((line) => ({
          id: line.id,
          date: line.scannedAt.toISOString(),
          file: line.sourceFile.originalName,
          row: line.sourceRowNumber,
        })),
      },
    };
  }

  return { status, summary, list, detail };
}
