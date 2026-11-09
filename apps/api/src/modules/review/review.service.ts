import { z } from "zod";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { LineKind } from "../../../generated/prisma/enums.js";
import { AppError } from "../../lib/errors.js";
import { enqueueJob, enqueueRecompute } from "../reconciliation/reconciliation.service.js";

export const queueQuerySchema = z.object({
  view: z.enum(["suggested", "none"]).default("suggested"),
  kind: z.enum(LineKind).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type QueueQuery = z.infer<typeof queueQuerySchema>;

export const suggestionIdSchema = z.strictObject({ id: z.uuid() });

const TABLES: Record<LineKind, string> = {
  SETTLEMENT: "settlement_lines",
  COD_REMITTANCE: "cod_remittance_lines",
  FREIGHT: "freight_lines",
  RETURN_SCAN: "return_scans",
};

/** SQL that gives every kind of line the same columns. Fixed text, never built from user input. */
const LINE_SQL: Record<LineKind, string> = {
  SETTLEMENT: `SELECT l.id::text AS id, s.name AS partner, l."settledOn" AS date,
      (l."netReceived" + l.tcs + l.tds)::text AS amount, l."orderIdRaw" AS "orderIdOnLine", NULL::text AS awb,
      f."originalName" AS file, l."sourceRowNumber" AS row
    FROM settlement_lines l JOIN sources s ON s.id = l."sourceId" JOIN uploaded_files f ON f.id = l."sourceFileId"`,
  COD_REMITTANCE: `SELECT l.id::text AS id, s.name AS partner, l."remittedOn" AS date,
      l."remittedAmount"::text AS amount, l."orderIdRaw" AS "orderIdOnLine", l.awb AS awb,
      f."originalName" AS file, l."sourceRowNumber" AS row
    FROM cod_remittance_lines l JOIN sources s ON s.id = l."aggregatorSourceId" JOIN uploaded_files f ON f.id = l."sourceFileId"`,
  FREIGHT: `SELECT l.id::text AS id, s.name AS partner, l."chargedOn" AS date,
      l."billedAmount"::text AS amount, l."orderIdRaw" AS "orderIdOnLine", l.awb AS awb,
      f."originalName" AS file, l."sourceRowNumber" AS row
    FROM freight_lines l JOIN sources s ON s.id = l."aggregatorSourceId" JOIN uploaded_files f ON f.id = l."sourceFileId"`,
  RETURN_SCAN: `SELECT l.id::text AS id, s.name AS partner, l."scannedAt" AS date,
      NULL::text AS amount, l."orderIdRaw" AS "orderIdOnLine", l.awb AS awb,
      f."originalName" AS file, l."sourceRowNumber" AS row
    FROM return_scans l JOIN sources s ON s.id = l."warehouseSourceId" JOIN uploaded_files f ON f.id = l."sourceFileId"`,
};

interface LineRow {
  id: string;
  partner: string;
  date: Date | null;
  amount: string | null;
  orderIdOnLine: string | null;
  awb: string | null;
  file: string;
  row: number;
}

export type ReviewService = ReturnType<typeof createReviewService>;

export function createReviewService({ prisma }: { prisma: PrismaClient }) {
  async function loadLines(kind: LineKind, ids: string[]): Promise<Map<string, LineRow>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.$queryRawUnsafe<LineRow[]>(
      `${LINE_SQL[kind]} WHERE l.id = ANY($1::uuid[]) AND l."matchStatus" = 'UNMATCHED'`,
      ids,
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  async function summary() {
    const rows = await Promise.all(
      (Object.keys(TABLES) as LineKind[]).map(async (kind) => {
        const unmatched = await prisma.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${TABLES[kind]} WHERE "matchStatus" = 'UNMATCHED'`,
        );
        const withSuggestions = await prisma.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(DISTINCT s."lineId")::int AS n FROM match_suggestions s
           JOIN ${TABLES[kind]} l ON l.id = s."lineId"
           WHERE s."lineKind" = '${kind}'::"LineKind" AND s.status = 'PENDING' AND l."matchStatus" = 'UNMATCHED'`,
        );
        const total = unmatched[0]?.n ?? 0;
        const suggested = withSuggestions[0]?.n ?? 0;
        return {
          kind,
          unmatched: total,
          withSuggestions: suggested,
          withoutCandidates: total - suggested,
        };
      }),
    );
    const [job, decided] = await Promise.all([
      prisma.processingJob.findFirst({
        where: { type: "SUGGEST_MATCHES" },
        orderBy: { queuedAt: "desc" },
        select: {
          status: true,
          stage: true,
          progressPct: true,
          errorMessage: true,
          finishedAt: true,
        },
      }),
      prisma.matchSuggestion.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    return {
      byKind: rows,
      unmatched: rows.reduce((sum, row) => sum + row.unmatched, 0),
      withSuggestions: rows.reduce((sum, row) => sum + row.withSuggestions, 0),
      withoutCandidates: rows.reduce((sum, row) => sum + row.withoutCandidates, 0),
      accepted: decided.find((entry) => entry.status === "ACCEPTED")?._count._all ?? 0,
      rejected: decided.find((entry) => entry.status === "REJECTED")?._count._all ?? 0,
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

  /** Lines with something to decide (view "suggested"), or lines no rule could place (view "none"). */
  async function queue(query: QueueQuery) {
    const kinds = query.kind ? [query.kind] : (Object.keys(TABLES) as LineKind[]);
    const offset = (query.page - 1) * query.pageSize;

    let keys: { kind: LineKind; id: string }[];
    let total: number;
    if (query.view === "suggested") {
      const kindList = Prisma.join(kinds.map((kind) => Prisma.sql`${kind}::"LineKind"`));
      const [rows, count] = await Promise.all([
        prisma.$queryRaw<{ kind: LineKind; id: string }[]>(Prisma.sql`
          SELECT s."lineKind" AS kind, s."lineId"::text AS id FROM match_suggestions s
          WHERE s.status = 'PENDING' AND s."lineKind" IN (${kindList})
          GROUP BY s."lineKind", s."lineId" ORDER BY max(s.score) DESC, s."lineId"
          LIMIT ${query.pageSize} OFFSET ${offset}`),
        prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
          SELECT count(*)::int AS n FROM (SELECT 1 FROM match_suggestions s
          WHERE s.status = 'PENDING' AND s."lineKind" IN (${kindList}) GROUP BY s."lineKind", s."lineId") x`),
      ]);
      keys = rows;
      total = count[0]?.n ?? 0;
    } else {
      const parts = kinds.map(
        (kind) => `SELECT '${kind}'::text AS kind, l.id::text AS id FROM ${TABLES[kind]} l
          WHERE l."matchStatus" = 'UNMATCHED' AND NOT EXISTS (
            SELECT 1 FROM match_suggestions s WHERE s."lineId" = l.id AND s.status = 'PENDING')`,
      );
      const union = parts.join(" UNION ALL ");
      const [rows, count] = await Promise.all([
        prisma.$queryRawUnsafe<{ kind: LineKind; id: string }[]>(
          `${union} ORDER BY kind, id LIMIT ${query.pageSize} OFFSET ${offset}`,
        ),
        prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM (${union}) x`),
      ]);
      keys = rows;
      total = count[0]?.n ?? 0;
    }

    const idsByKind = new Map<LineKind, string[]>();
    for (const key of keys) idsByKind.set(key.kind, [...(idsByKind.get(key.kind) ?? []), key.id]);
    const lineMaps = new Map<LineKind, Map<string, LineRow>>();
    for (const [kind, ids] of idsByKind) lineMaps.set(kind, await loadLines(kind, ids));

    const suggestions =
      query.view === "suggested" && keys.length > 0
        ? await prisma.matchSuggestion.findMany({
            where: {
              status: "PENDING",
              OR: keys.map((key) => ({ lineKind: key.kind, lineId: key.id })),
            },
            orderBy: [{ score: "desc" }, { id: "asc" }],
            include: {
              candidate: {
                include: {
                  channel: { select: { name: true } },
                  courier: { select: { name: true } },
                  result: { select: { expected: true, status: true } },
                },
              },
            },
          })
        : [];

    const items = keys.flatMap((key) => {
      const line = lineMaps.get(key.kind)?.get(key.id);
      if (!line) return [];
      return [
        {
          key: `${key.kind}:${key.id}`,
          lineKind: key.kind,
          lineId: key.id,
          partner: line.partner,
          date: line.date?.toISOString() ?? null,
          amount: line.amount,
          orderIdOnLine: line.orderIdOnLine,
          awb: line.awb,
          file: line.file,
          row: line.row,
          suggestions: suggestions
            .filter((s) => s.lineKind === key.kind && s.lineId === key.id)
            .map((s) => ({
              id: s.id,
              score: s.score,
              reasons: s.reasons as string[],
              origin: s.origin,
              aiModel: s.aiModel,
              order: {
                id: s.candidate.id,
                orderId: s.candidate.orderId,
                channel: s.candidate.channel.name,
                courier: s.candidate.courier?.name ?? null,
                value: s.candidate.value.toFixed(2),
                expected: s.candidate.result?.expected?.toFixed(2) ?? null,
                orderDate: s.candidate.orderDate.toISOString(),
                status: s.candidate.result?.status ?? null,
              },
            })),
        },
      ];
    });

    return { view: query.view, total, page: query.page, pageSize: query.pageSize, items };
  }

  /** A person accepts a suggestion: the line is linked to the order and results are recalculated. */
  async function accept(args: { id: string; userId: string }) {
    const suggestion = await prisma.matchSuggestion.findUnique({ where: { id: args.id } });
    if (!suggestion) throw new AppError("NOT_FOUND", 404, "Suggestion not found.");
    if (suggestion.status !== "PENDING") {
      throw new AppError("CONFLICT", 409, "This suggestion was already decided or replaced.");
    }

    await prisma.$transaction(async (tx) => {
      const linked = await tx.$executeRawUnsafe(
        `UPDATE ${TABLES[suggestion.lineKind]} SET "orderPk" = $1::uuid, "matchStatus" = 'ACCEPTED'
         WHERE id = $2::uuid AND "matchStatus" = 'UNMATCHED'`,
        suggestion.candidateOrderPk,
        suggestion.lineId,
      );
      if (linked !== 1) {
        throw new AppError("CONFLICT", 409, "This line has already been matched.");
      }
      const claimed = await tx.matchSuggestion.updateMany({
        where: { id: suggestion.id, status: "PENDING" },
        data: { status: "ACCEPTED", decidedById: args.userId, decidedAt: new Date() },
      });
      if (claimed.count !== 1)
        throw new AppError("CONFLICT", 409, "This suggestion was just decided.");
      // The line has its order now, so the other candidates for it are closed by the system.
      await tx.matchSuggestion.updateMany({
        where: {
          lineKind: suggestion.lineKind,
          lineId: suggestion.lineId,
          status: "PENDING",
          id: { not: suggestion.id },
        },
        data: { status: "SUPERSEDED" },
      });
    });

    await enqueueRecompute(prisma, args.userId).catch(() => undefined);
    return {
      id: suggestion.id,
      orderPk: suggestion.candidateOrderPk,
      lineKind: suggestion.lineKind,
    };
  }

  async function reject(args: { id: string; userId: string }) {
    const result = await prisma.matchSuggestion.updateMany({
      where: { id: args.id, status: "PENDING" },
      data: { status: "REJECTED", decidedById: args.userId, decidedAt: new Date() },
    });
    if (result.count !== 1) {
      throw new AppError("CONFLICT", 409, "This suggestion was already decided or does not exist.");
    }
    return { id: args.id };
  }

  /** Looks for suggestions again (the job also runs after every recalculation). */
  async function rerun(userId: string) {
    return enqueueJob(prisma, "SUGGEST_MATCHES", userId, "MATCH_SUGGESTIONS");
  }

  return { summary, queue, accept, reject, rerun };
}
