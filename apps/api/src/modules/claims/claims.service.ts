import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { ClaimStatus } from "../../../generated/prisma/enums.js";
import { AppError } from "../../lib/errors.js";
import { decimalToPaise, paiseToAmount, parseAmountToPaise } from "../rate-cards/money.js";
import { enqueueJob } from "../reconciliation/reconciliation.service.js";
import { claimLabel, CLAIM_TYPE_LABELS } from "./claim-rules.js";
import { buildClaimCsv, claimFileName } from "./claims-csv.js";
import type { Evidence } from "./evidence.js";

export const listClaimsQuerySchema = z.object({
  status: z.enum(ClaimStatus).optional(),
  partnerId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const claimItemsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const claimIdSchema = z.strictObject({ id: z.uuid() });
export const itemIdSchema = z.strictObject({ itemId: z.uuid() });

export const statusBodySchema = z.strictObject({
  status: z.enum(["RECOVERED", "CLOSED"]),
  /** Rupees as text, for example "1409.00". Required for RECOVERED. */
  recovered: z
    .string()
    .trim()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount like 1409 or 1409.50.")
    .optional(),
});

export type ClaimsService = ReturnType<typeof createClaimsService>;

const money = (value: { toFixed(digits: number): string }) => value.toFixed(2);

export function createClaimsService({ prisma }: { prisma: PrismaClient }) {
  const claimDto = (
    claim: {
      id: string;
      claimNo: number;
      status: ClaimStatus;
      total: { toFixed(d: number): string };
      recovered: { toFixed(d: number): string };
      itemCount: number;
      exportedAt: Date | null;
      closedAt: Date | null;
      createdAt: Date;
      partner: { id: string; name: string };
    },
    oldestAgeDays: number | null,
  ) => ({
    id: claim.id,
    claimNo: claim.claimNo,
    label: claimLabel(claim.claimNo),
    partner: claim.partner,
    status: claim.status,
    itemCount: claim.itemCount,
    total: money(claim.total),
    recovered: money(claim.recovered),
    oldestAgeDays,
    exportedAt: claim.exportedAt?.toISOString() ?? null,
    closedAt: claim.closedAt?.toISOString() ?? null,
    createdAt: claim.createdAt.toISOString(),
  });

  async function summary() {
    const [groups, latest, job] = await Promise.all([
      prisma.claim.groupBy({
        by: ["status"],
        _count: { _all: true },
        _sum: { total: true, recovered: true, itemCount: true },
      }),
      prisma.orderResult.findFirst({ orderBy: { computedAt: "desc" }, select: { asOf: true } }),
      prisma.processingJob.findFirst({
        where: { type: "BUILD_CLAIMS" },
        orderBy: { queuedAt: "desc" },
        select: {
          status: true,
          stage: true,
          progressPct: true,
          errorMessage: true,
          finishedAt: true,
        },
      }),
    ]);
    const pick = (status: ClaimStatus) => {
      const group = groups.find((entry) => entry.status === status);
      return {
        claims: group?._count._all ?? 0,
        orders: group?._sum.itemCount ?? 0,
        total: money(group?._sum.total ?? { toFixed: () => "0.00" }),
        recovered: money(group?._sum.recovered ?? { toFixed: () => "0.00" }),
      };
    };
    return {
      asOf: latest?.asOf.toISOString() ?? null,
      open: pick("OPEN"),
      exported: pick("EXPORTED"),
      recovered: pick("RECOVERED"),
      closed: pick("CLOSED"),
      job: job
        ? {
            status: job.status,
            stage: job.stage,
            progressPct: job.progressPct,
            errorMessage: job.errorMessage,
            finishedAt: job.finishedAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  async function list(query: z.infer<typeof listClaimsQuerySchema>) {
    const where = { status: query.status, partnerSourceId: query.partnerId };
    const [total, claims] = await Promise.all([
      prisma.claim.count({ where }),
      prisma.claim.findMany({
        where,
        orderBy: [{ status: "asc" }, { total: "desc" }, { claimNo: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { partner: { select: { id: true, name: true } } },
      }),
    ]);
    const ages = claims.length
      ? await prisma.claimItem.groupBy({
          by: ["claimId"],
          where: { claimId: { in: claims.map((claim) => claim.id) } },
          _max: { ageDays: true },
        })
      : [];
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: claims.map((claim) =>
        claimDto(claim, ages.find((age) => age.claimId === claim.id)?._max.ageDays ?? null),
      ),
    };
  }

  async function getOne(id: string, query: z.infer<typeof claimItemsQuerySchema>) {
    const claim = await prisma.claim.findUnique({
      where: { id },
      include: { partner: { select: { id: true, name: true } } },
    });
    if (!claim) throw new AppError("NOT_FOUND", 404, "Claim not found.");
    const [items, oldest, byType] = await Promise.all([
      prisma.claimItem.findMany({
        where: { claimId: id },
        orderBy: [{ amount: "desc" }, { id: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { order: { select: { orderId: true } } },
      }),
      prisma.claimItem.aggregate({ where: { claimId: id }, _max: { ageDays: true } }),
      prisma.claimItem.groupBy({
        by: ["claimType"],
        where: { claimId: id },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);
    return {
      claim: claimDto(claim, oldest._max.ageDays ?? null),
      byType: byType.map((entry) => ({
        type: entry.claimType,
        label: CLAIM_TYPE_LABELS[entry.claimType],
        orders: entry._count._all,
        amount: entry._sum.amount ? money(entry._sum.amount) : "0.00",
      })),
      page: query.page,
      pageSize: query.pageSize,
      items: items.map((item) => ({
        id: item.id,
        orderPk: item.orderPk,
        orderId: item.order.orderId,
        claimType: item.claimType,
        typeLabel: CLAIM_TYPE_LABELS[item.claimType],
        amount: money(item.amount),
        ageDays: item.ageDays,
        ageBasisDate: item.ageBasisDate.toISOString(),
      })),
    };
  }

  async function getItem(itemId: string) {
    const item = await prisma.claimItem.findUnique({
      where: { id: itemId },
      include: {
        claim: { select: { claimNo: true, status: true } },
        order: { select: { orderId: true } },
      },
    });
    if (!item) throw new AppError("NOT_FOUND", 404, "Claim item not found.");
    return {
      id: item.id,
      claimNo: item.claim.claimNo,
      claimLabel: claimLabel(item.claim.claimNo),
      claimStatus: item.claim.status,
      orderId: item.order.orderId,
      claimType: item.claimType,
      typeLabel: CLAIM_TYPE_LABELS[item.claimType],
      amount: money(item.amount),
      ageDays: item.ageDays,
      ageBasisDate: item.ageBasisDate.toISOString(),
      evidence: item.evidence as unknown as Evidence,
    };
  }

  /**
   * Builds the evidence file for a claim. An open claim becomes EXPORTED (frozen) the first time:
   * later findings go into a new open claim. An exported claim can be downloaded again.
   */
  async function exportClaim(id: string, userId: string) {
    const claim = await prisma.claim.findUnique({
      where: { id },
      include: { partner: { select: { name: true } } },
    });
    if (!claim) throw new AppError("NOT_FOUND", 404, "Claim not found.");
    if (claim.itemCount === 0) {
      throw new AppError(
        "CONFLICT",
        409,
        "This claim has no orders, so there is nothing to export.",
      );
    }
    const items = await prisma.claimItem.findMany({
      where: { claimId: id },
      orderBy: [{ amount: "desc" }, { id: "asc" }],
      include: { order: { select: { orderId: true } } },
    });
    const csv = buildClaimCsv({
      claimNo: claim.claimNo,
      partner: claim.partner.name,
      items: items.map((item) => ({
        orderId: item.order.orderId,
        claimType: item.claimType,
        amount: money(item.amount),
        ageBasisDate: item.ageBasisDate,
        ageDays: item.ageDays,
        evidence: item.evidence as unknown as Evidence,
      })),
    });

    let exportedAt = claim.exportedAt;
    if (claim.status === "OPEN") {
      exportedAt = new Date();
      const frozen = await prisma.claim.updateMany({
        where: { id, status: "OPEN" },
        data: { status: "EXPORTED", exportedAt, exportedById: userId },
      });
      if (frozen.count !== 1) exportedAt = claim.exportedAt;
    }
    return {
      fileName: claimFileName(claim.claimNo, claim.partner.name),
      csv,
      itemCount: items.length,
      total: money(claim.total),
      exportedAt: exportedAt?.toISOString() ?? null,
      status: claim.status === "OPEN" ? ("EXPORTED" as const) : claim.status,
    };
  }

  /** Records that money came back (RECOVERED) or that the claim is dropped (CLOSED). */
  async function setStatus(id: string, body: z.infer<typeof statusBodySchema>) {
    const claim = await prisma.claim.findUnique({ where: { id } });
    if (!claim) throw new AppError("NOT_FOUND", 404, "Claim not found.");

    if (body.status === "RECOVERED") {
      if (claim.status !== "EXPORTED") {
        throw new AppError(
          "CONFLICT",
          409,
          "Export the evidence first. Only an exported claim can be marked as recovered.",
        );
      }
      const recovered = body.recovered ? parseAmountToPaise(body.recovered) : null;
      if (recovered === null || recovered <= 0n) {
        throw new AppError("VALIDATION_FAILED", 422, "Enter the amount that was recovered.", {
          fields: { recovered: "Enter the amount recovered, more than zero." },
        });
      }
      if (recovered > decimalToPaise(claim.total)) {
        throw new AppError(
          "VALIDATION_FAILED",
          422,
          "The recovered amount is more than the claim.",
          {
            fields: { recovered: `It cannot be more than ${money(claim.total)}.` },
          },
        );
      }
      const updated = await prisma.claim.updateMany({
        where: { id, status: "EXPORTED" },
        data: { status: "RECOVERED", recovered: paiseToAmount(recovered) },
      });
      if (updated.count !== 1)
        throw new AppError("CONFLICT", 409, "The claim changed. Reload and try again.");
      return { id, status: "RECOVERED" as const, recovered: paiseToAmount(recovered) };
    }

    if (claim.status === "CLOSED")
      throw new AppError("CONFLICT", 409, "This claim is already closed.");
    await prisma.claim.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date() } });
    return { id, status: "CLOSED" as const, recovered: money(claim.recovered) };
  }

  async function rebuild(userId: string) {
    return enqueueJob(prisma, "BUILD_CLAIMS", userId, "CLAIMS");
  }

  return { summary, list, getOne, getItem, exportClaim, setStatus, rebuild };
}
