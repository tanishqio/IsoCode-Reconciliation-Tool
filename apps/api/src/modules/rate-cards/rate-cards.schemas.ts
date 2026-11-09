import { z } from "zod";
import { PaymentType, RateRuleType } from "../../../generated/prisma/enums.js";

const AMOUNT_MESSAGE = "Enter an amount in rupees, like 60 or 60.50.";
const amountText = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, AMOUNT_MESSAGE);

const MAX_RULES = 30;
const MAX_WEIGHT_GRAMS = 1_000_000;

export const ruleInputSchema = z
  .strictObject({
    ruleType: z.enum(RateRuleType),
    /** COMMISSION only. 2000 means 20%. */
    basisPoints: z.number().int().min(0).max(10_000).nullish(),
    /** Every other type. Rupees as text, so no floating point is involved. */
    amount: amountText.nullish(),
    /** FREIGHT_SLAB only. Empty means no limit on that side. */
    minWeightGrams: z.number().int().min(0).max(MAX_WEIGHT_GRAMS).nullish(),
    maxWeightGrams: z.number().int().min(0).max(MAX_WEIGHT_GRAMS).nullish(),
  })
  .superRefine((rule, ctx) => {
    const add = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const isSlab = rule.ruleType === "FREIGHT_SLAB";

    if (rule.ruleType === "COMMISSION") {
      if (rule.basisPoints == null) add("basisPoints", "Enter the commission percentage.");
      if (rule.amount != null) add("amount", "Commission is a percentage, not an amount.");
    } else {
      if (rule.amount == null) add("amount", "Enter the amount.");
      if (rule.basisPoints != null) add("basisPoints", "Only commission is a percentage.");
    }

    if (!isSlab && (rule.minWeightGrams != null || rule.maxWeightGrams != null)) {
      add("minWeightGrams", "Only the delivery charge depends on weight.");
    }
    if (
      isSlab &&
      rule.minWeightGrams != null &&
      rule.maxWeightGrams != null &&
      rule.maxWeightGrams < rule.minWeightGrams
    ) {
      add("maxWeightGrams", "The highest weight must not be lower than the lowest.");
    }
  });

export type RuleInput = z.infer<typeof ruleInputSchema>;

const ONE_ONLY: RateRuleType[] = ["COMMISSION", "FIXED_FEE", "COD_FEE", "REVERSE_FREIGHT"];

/** Problems that involve more than one rule: duplicates and overlapping weight bands. */
export function crossRuleProblems(
  rules: readonly RuleInput[],
): { index: number; field: string; message: string }[] {
  const problems: { index: number; field: string; message: string }[] = [];
  const seen = new Set<RateRuleType>();

  rules.forEach((rule, index) => {
    if (ONE_ONLY.includes(rule.ruleType)) {
      if (seen.has(rule.ruleType)) {
        problems.push({ index, field: "ruleType", message: "Each fee can be added only once." });
      }
      seen.add(rule.ruleType);
    }
  });

  const slabs = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.ruleType === "FREIGHT_SLAB");
  slabs.forEach((a, position) => {
    for (const b of slabs.slice(position + 1)) {
      const aLow = a.rule.minWeightGrams ?? 0;
      const bLow = b.rule.minWeightGrams ?? 0;
      const aHigh = a.rule.maxWeightGrams ?? Number.POSITIVE_INFINITY;
      const bHigh = b.rule.maxWeightGrams ?? Number.POSITIVE_INFINITY;
      if (aLow <= bHigh && bLow <= aHigh) {
        problems.push({
          index: b.index,
          field: "minWeightGrams",
          message: "This weight range overlaps another delivery charge.",
        });
      }
    }
  });
  return problems;
}

export const rulesSchema = z
  .array(ruleInputSchema)
  .min(1, "Add at least one fee.")
  .max(MAX_RULES, `A rate card can have at most ${MAX_RULES} fees.`)
  .superRefine((rules, ctx) => {
    for (const problem of crossRuleProblems(rules)) {
      ctx.addIssue({
        code: "custom",
        path: [problem.index, problem.field],
        message: problem.message,
      });
    }
  });

const noteSchema = z.string().trim().max(200).nullish();

export const createCardSchema = z.strictObject({
  channelSourceId: z.uuid(),
  courierSourceId: z.uuid().nullish(),
  note: noteSchema,
  /** True while the values are demo values and not a real partner's rates. */
  isSampleData: z.boolean().optional(),
  rules: rulesSchema,
});
export type CreateCardInput = z.infer<typeof createCardSchema>;

/** Editing never changes the channel or courier: it makes a new version of the same card. */
export const updateCardSchema = z.strictObject({
  note: noteSchema,
  /** Leave out to keep the old card's setting. */
  isSampleData: z.boolean().optional(),
  rules: rulesSchema,
});
export type UpdateCardInput = z.infer<typeof updateCardSchema>;

export const calculateSchema = z.strictObject({
  rateCardId: z.uuid(),
  paymentType: z.enum(PaymentType),
  orderValue: amountText,
  weightGrams: z.number().int().min(0).max(MAX_WEIGHT_GRAMS).nullish(),
  isReturn: z.boolean().default(false),
});
export type CalculateInput = z.infer<typeof calculateSchema>;

export const listQuerySchema = z.object({
  includeOlder: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const idParamSchema = z.strictObject({ id: z.uuid() });
