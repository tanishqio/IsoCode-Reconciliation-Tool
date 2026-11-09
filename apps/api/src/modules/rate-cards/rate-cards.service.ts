import type { Prisma, PrismaClient } from "../../../generated/prisma/client.js";
import type {
  PaymentType,
  RateCardStatus,
  RateRuleType,
  SourceKind,
} from "../../../generated/prisma/enums.js";
import { AppError } from "../../lib/errors.js";
import { computeExpected, linesToAmounts, type CalcRule } from "./expected-amount.js";
import { paiseToAmount, parseAmountToPaise } from "./money.js";
import type {
  CalculateInput,
  CreateCardInput,
  RuleInput,
  UpdateCardInput,
} from "./rate-cards.schemas.js";

// What the API sends. Money is text ("60.00"); dates are ISO text.

export interface RateRuleDto {
  id: string;
  ruleType: RateRuleType;
  appliesToPayment: PaymentType | null;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  basisPoints: number | null;
  amount: string | null;
}

export interface RateCardDto {
  id: string;
  channel: { id: string; name: string };
  courier: { id: string; name: string } | null;
  versionNo: number;
  status: RateCardStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isSampleData: boolean;
  note: string | null;
  createdAt: string;
  createdByName: string;
  rules: RateRuleDto[];
}

export type CalculateResultDto =
  | {
      ok: true;
      rateCardId: string;
      versionNo: number;
      expected: string;
      lines: { label: string; amount: string }[];
    }
  | { ok: false; rateCardId: string; code: string; message: string };

const CHANNEL_KINDS: SourceKind[] = ["WEBSITE", "MARKETPLACE", "QUICK_COMMERCE"];
const COURIER_KINDS: SourceKind[] = ["COURIER_AGGREGATOR"];

const cardInclude = {
  channel: { select: { id: true, name: true } },
  courier: { select: { id: true, name: true } },
  createdBy: { select: { name: true } },
  rules: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.RateCardInclude;

type CardRow = Prisma.RateCardGetPayload<{ include: typeof cardInclude }>;

/** The delegates a transaction also has, so helpers work with the client and with a transaction. */
type Db = Pick<PrismaClient, "rateCard" | "rateCardRule" | "source" | "$executeRaw">;

function toDto(row: CardRow): RateCardDto {
  return {
    id: row.id,
    channel: row.channel,
    courier: row.courier,
    versionNo: row.versionNo,
    status: row.status,
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    isSampleData: row.isSampleData,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy.name,
    rules: row.rules.map((rule) => ({
      id: rule.id,
      ruleType: rule.ruleType,
      appliesToPayment: rule.appliesToPayment,
      minWeightGrams: rule.minWeightGrams,
      maxWeightGrams: rule.maxWeightGrams,
      basisPoints: rule.basisPoints,
      amount: rule.amount === null ? null : rule.amount.toFixed(2),
    })),
  };
}

/** Rules as the calculator wants them: money in whole paise. */
export function toCalcRules(rules: readonly RateRuleDto[]): CalcRule[] {
  return rules.map((rule) => ({
    ruleType: rule.ruleType,
    minWeightGrams: rule.minWeightGrams,
    maxWeightGrams: rule.maxWeightGrams,
    basisPoints: rule.basisPoints,
    amountPaise: rule.amount === null ? null : parseAmountToPaise(rule.amount),
  }));
}

const TYPE_ORDER: Record<RateRuleType, number> = {
  COMMISSION: 0,
  FIXED_FEE: 1,
  FREIGHT_SLAB: 2,
  COD_FEE: 3,
  REVERSE_FREIGHT: 4,
};

/** Database rows for a list of validated rules, in a fixed order so a card always reads the same. */
function toRuleRows(
  rules: readonly RuleInput[],
): Omit<Prisma.RateCardRuleCreateManyInput, "rateCardId">[] {
  return [...rules]
    .sort(
      (a, b) =>
        TYPE_ORDER[a.ruleType] - TYPE_ORDER[b.ruleType] ||
        (a.minWeightGrams ?? 0) - (b.minWeightGrams ?? 0),
    )
    .map((rule, sortOrder) => {
      const paise = rule.amount == null ? null : parseAmountToPaise(rule.amount);
      return {
        ruleType: rule.ruleType,
        // Only the COD fee depends on how the customer paid.
        appliesToPayment: rule.ruleType === "COD_FEE" ? "COD" : null,
        minWeightGrams: rule.ruleType === "FREIGHT_SLAB" ? (rule.minWeightGrams ?? 0) : null,
        maxWeightGrams: rule.ruleType === "FREIGHT_SLAB" ? (rule.maxWeightGrams ?? null) : null,
        basisPoints: rule.ruleType === "COMMISSION" ? (rule.basisPoints ?? null) : null,
        amount: paise === null ? null : paiseToAmount(paise),
        sortOrder,
      };
    });
}

export type RateCardsService = ReturnType<typeof createRateCardsService>;

export function createRateCardsService({ prisma }: { prisma: PrismaClient }) {
  /** Only one person can change a given (channel, courier) pair at a time. Released at commit. */
  async function lockPair(db: Db, channelSourceId: string, courierSourceId: string | null) {
    const key = `rate-card:${channelSourceId}:${courierSourceId ?? "-"}`;
    await db.$executeRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) AS locked`;
  }

  async function assertSource(
    db: Db,
    id: string,
    kinds: SourceKind[],
    field: string,
    what: string,
  ): Promise<void> {
    const source = await db.source.findUnique({
      where: { id },
      select: { kind: true, isActive: true },
    });
    if (!source || !source.isActive || !kinds.includes(source.kind)) {
      throw new AppError("VALIDATION_FAILED", 422, `That is not a valid ${what}.`, [
        { path: field, message: `Choose a valid ${what}.` },
      ]);
    }
  }

  async function nextVersionNo(
    db: Db,
    channelSourceId: string,
    courierSourceId: string | null,
  ): Promise<number> {
    const latest = await db.rateCard.aggregate({
      where: { channelSourceId, courierSourceId },
      _max: { versionNo: true },
    });
    return (latest._max.versionNo ?? 0) + 1;
  }

  async function list(options: { includeOlder: boolean }): Promise<RateCardDto[]> {
    const rows = await prisma.rateCard.findMany({
      where: options.includeOlder ? {} : { status: "ACTIVE" },
      include: cardInclude,
      orderBy: [{ channel: { name: "asc" } }, { courier: { name: "asc" } }, { versionNo: "desc" }],
    });
    return rows.map(toDto);
  }

  async function getOne(id: string): Promise<RateCardDto> {
    const row = await prisma.rateCard.findUnique({ where: { id }, include: cardInclude });
    if (!row) throw new AppError("NOT_FOUND", 404, "That rate card was not found.");
    return toDto(row);
  }

  async function create(input: CreateCardInput, userId: string): Promise<RateCardDto> {
    const channelSourceId = input.channelSourceId;
    const courierSourceId = input.courierSourceId ?? null;
    await assertSource(prisma, channelSourceId, CHANNEL_KINDS, "channelSourceId", "channel");
    if (courierSourceId) {
      await assertSource(prisma, courierSourceId, COURIER_KINDS, "courierSourceId", "courier");
    }

    const id = await prisma.$transaction(async (tx) => {
      await lockPair(tx, channelSourceId, courierSourceId);
      const current = await tx.rateCard.findFirst({
        where: { channelSourceId, courierSourceId, status: "ACTIVE" },
        select: { id: true },
      });
      if (current) {
        throw new AppError(
          "CONFLICT",
          409,
          "A rate card already exists for this channel and courier. Open it and edit it to make a new version.",
          { existingId: current.id },
        );
      }
      const created = await tx.rateCard.create({
        data: {
          channelSourceId,
          courierSourceId,
          versionNo: await nextVersionNo(tx, channelSourceId, courierSourceId),
          status: "ACTIVE",
          // The first card applies to every order date until a newer version replaces it.
          effectiveFrom: null,
          isSampleData: input.isSampleData ?? false,
          note: input.note?.trim() || null,
          createdById: userId,
          rules: { createMany: { data: toRuleRows(input.rules) } },
        },
        select: { id: true },
      });
      return created.id;
    });
    return getOne(id);
  }

  /** Editing makes a new version. The old version is kept, marked SUPERSEDED, and stops on this date. */
  async function createNewVersion(
    id: string,
    input: UpdateCardInput,
    userId: string,
  ): Promise<RateCardDto> {
    const existing = await prisma.rateCard.findUnique({
      where: { id },
      select: { channelSourceId: true, courierSourceId: true },
    });
    if (!existing) throw new AppError("NOT_FOUND", 404, "That rate card was not found.");

    const newId = await prisma.$transaction(async (tx) => {
      await lockPair(tx, existing.channelSourceId, existing.courierSourceId);
      const old = await tx.rateCard.findUniqueOrThrow({ where: { id } });
      if (old.status !== "ACTIVE") {
        throw new AppError(
          "CONFLICT",
          409,
          "Only the current version of a rate card can be edited. Close this and open the current version.",
        );
      }
      const now = new Date();
      await tx.rateCard.update({
        where: { id },
        data: { status: "SUPERSEDED", effectiveTo: now },
      });
      const created = await tx.rateCard.create({
        data: {
          channelSourceId: old.channelSourceId,
          courierSourceId: old.courierSourceId,
          versionNo: await nextVersionNo(tx, old.channelSourceId, old.courierSourceId),
          status: "ACTIVE",
          effectiveFrom: now,
          isSampleData: input.isSampleData ?? old.isSampleData,
          note: input.note === undefined ? old.note : input.note?.trim() || null,
          createdById: userId,
          rules: { createMany: { data: toRuleRows(input.rules) } },
        },
        select: { id: true },
      });
      return created.id;
    });
    return getOne(newId);
  }

  /** "What would this card expect for an order like this?" Used by the check panel on the screen. */
  async function calculate(input: CalculateInput): Promise<CalculateResultDto> {
    const card = await getOne(input.rateCardId);
    const orderValuePaise = parseAmountToPaise(input.orderValue);
    if (orderValuePaise === null) {
      throw new AppError("VALIDATION_FAILED", 422, "The order value is not valid.");
    }
    const result = computeExpected(toCalcRules(card.rules), {
      orderValuePaise,
      paymentType: input.paymentType,
      weightGrams: input.weightGrams ?? null,
      isReturn: input.isReturn,
    });
    if (!result.ok) {
      return { ok: false, rateCardId: card.id, code: result.code, message: result.message };
    }
    return {
      ok: true,
      rateCardId: card.id,
      versionNo: card.versionNo,
      expected: paiseToAmount(result.expectedPaise),
      lines: linesToAmounts(result.lines),
    };
  }

  return { list, getOne, create, createNewVersion, calculate };
}
