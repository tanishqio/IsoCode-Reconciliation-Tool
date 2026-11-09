import type { RateCard, RateRule, RuleInput, RuleType } from "./rate-cards-api";

// Labels and form logic for the rate cards screen. No React here, so it is easy to test.

export const RULE_TYPE_LABELS: Record<RuleType, string> = {
  COMMISSION: "Commission",
  FIXED_FEE: "Fixed fee",
  FREIGHT_SLAB: "Delivery charge",
  COD_FEE: "COD fee",
  REVERSE_FREIGHT: "Return delivery charge",
};

/** One line on what a fee does, shown in the form. */
export const RULE_TYPE_HELP: Record<RuleType, string> = {
  COMMISSION: "A share of the order value.",
  FIXED_FEE: "The same amount on every order.",
  FREIGHT_SLAB: "Depends on the parcel weight. Add one per weight range.",
  COD_FEE: "Only on cash-on-delivery orders.",
  REVERSE_FREIGHT: "Charged when an order is returned.",
};

export const RULE_TYPES = Object.keys(RULE_TYPE_LABELS) as RuleType[];

/** Fees that can appear only once on a card. */
const SINGLE_FEE: readonly RuleType[] = ["COMMISSION", "FIXED_FEE", "COD_FEE", "REVERSE_FREIGHT"];

const GRAMS = new Intl.NumberFormat("en-IN");

/** "0 to 500 g", "2,001 g and above", "Any weight". */
export function describeWeightBand(min: number | null, max: number | null): string {
  const low = min ?? 0;
  if (max === null) return low === 0 ? "Any weight" : `${GRAMS.format(low)} g and above`;
  return `${GRAMS.format(low)} to ${GRAMS.format(max)} g`;
}

/** What a fee applies to, in words. */
export function describeAppliesTo(rule: RateRule): string {
  switch (rule.ruleType) {
    case "COMMISSION":
      return "Share of the order value";
    case "FIXED_FEE":
      return "Every order";
    case "FREIGHT_SLAB":
      return describeWeightBand(rule.minWeightGrams, rule.maxWeightGrams);
    case "COD_FEE":
      return "Cash-on-delivery orders";
    case "REVERSE_FREIGHT":
      return "Returned orders";
  }
}

/** 2000 -> "20", 1850 -> "18.5", 1805 -> "18.05". Whole-number arithmetic only. */
export function basisPointsToPercent(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const rest = String(basisPoints % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return rest === "" ? String(whole) : `${whole}.${rest}`;
}

/** "20" -> 2000, "18.5" -> 1850. Null if the text is not a percentage from 0 to 100 with up to 2 decimals. */
export function percentToBasisPoints(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return basisPoints <= 10_000 ? basisPoints : null;
}

export const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export function currentVersionOf(card: RateCard): boolean {
  return card.status === "ACTIVE";
}

export function cardTitle(card: Pick<RateCard, "channel" | "courier">): string {
  return card.courier ? `${card.channel.name} with ${card.courier.name}` : card.channel.name;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function formatDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso));
}

/** "Since the start" for the first version, or "From 9 Nov 2026". */
export function describeEffective(card: Pick<RateCard, "effectiveFrom" | "effectiveTo">): string {
  const from = card.effectiveFrom ? `From ${formatDate(card.effectiveFrom)}` : "From the start";
  return card.effectiveTo ? `${from} until ${formatDate(card.effectiveTo)}` : from;
}

// ---------------------------------------------------------------------------
// The edit form. Every field is text while the person types.
// ---------------------------------------------------------------------------

export interface DraftRule {
  /** Only for React lists. */
  key: string;
  ruleType: RuleType;
  percent: string;
  amount: string;
  minWeight: string;
  maxWeight: string;
}

export type DraftField = "ruleType" | "percent" | "amount" | "minWeight" | "maxWeight";
export type DraftErrors = Record<string, Partial<Record<DraftField, string>>>;

let nextKey = 0;
const newKey = () => `rule-${nextKey++}`;

export function emptyDraft(ruleType: RuleType = "FIXED_FEE"): DraftRule {
  return { key: newKey(), ruleType, percent: "", amount: "", minWeight: "", maxWeight: "" };
}

export function draftFromRule(rule: RateRule): DraftRule {
  return {
    key: newKey(),
    ruleType: rule.ruleType,
    percent: rule.basisPoints === null ? "" : basisPointsToPercent(rule.basisPoints),
    amount: rule.amount ?? "",
    minWeight: rule.ruleType === "FREIGHT_SLAB" ? String(rule.minWeightGrams ?? 0) : "",
    maxWeight: rule.maxWeightGrams === null ? "" : String(rule.maxWeightGrams),
  };
}

const WEIGHT_PATTERN = /^\d{1,7}$/;

/** Problems the person can fix before sending. The server checks everything again. */
export function validateDrafts(drafts: readonly DraftRule[]): DraftErrors {
  const errors: DraftErrors = {};
  const add = (draft: DraftRule, field: DraftField, message: string) => {
    errors[draft.key] = { ...errors[draft.key], [field]: message };
  };

  const seen = new Set<RuleType>();
  const bands: { draft: DraftRule; low: number; high: number }[] = [];

  for (const draft of drafts) {
    if (SINGLE_FEE.includes(draft.ruleType)) {
      if (seen.has(draft.ruleType)) add(draft, "ruleType", "Each fee can be added only once.");
      seen.add(draft.ruleType);
    }

    if (draft.ruleType === "COMMISSION") {
      if (percentToBasisPoints(draft.percent) === null) {
        add(draft, "percent", "Enter a percentage from 0 to 100, like 20 or 18.5.");
      }
    } else if (!AMOUNT_PATTERN.test(draft.amount.trim())) {
      add(draft, "amount", "Enter an amount in rupees, like 60 or 60.50.");
    }

    if (draft.ruleType === "FREIGHT_SLAB") {
      const minText = draft.minWeight.trim();
      const maxText = draft.maxWeight.trim();
      const minOk = minText === "" || WEIGHT_PATTERN.test(minText);
      const maxOk = maxText === "" || WEIGHT_PATTERN.test(maxText);
      if (!minOk) add(draft, "minWeight", "Whole grams, like 500.");
      if (!maxOk) add(draft, "maxWeight", "Whole grams, or leave empty for no limit.");
      if (minOk && maxOk) {
        const low = minText === "" ? 0 : Number(minText);
        const high = maxText === "" ? Number.POSITIVE_INFINITY : Number(maxText);
        if (high < low) add(draft, "maxWeight", "Must not be lower than the lowest weight.");
        else bands.push({ draft, low, high });
      }
    }
  }

  bands.forEach((a, position) => {
    for (const b of bands.slice(position + 1)) {
      if (a.low <= b.high && b.low <= a.high) {
        add(b.draft, "minWeight", "This weight range overlaps another delivery charge.");
      }
    }
  });

  return errors;
}

export const hasErrors = (errors: DraftErrors) => Object.keys(errors).length > 0;

/** The fees as the API wants them. Call only when validateDrafts found nothing. */
export function toRuleInputs(drafts: readonly DraftRule[]): RuleInput[] {
  return drafts.map((draft): RuleInput => {
    if (draft.ruleType === "COMMISSION") {
      return { ruleType: "COMMISSION", basisPoints: percentToBasisPoints(draft.percent) ?? 0 };
    }
    if (draft.ruleType === "FREIGHT_SLAB") {
      return {
        ruleType: "FREIGHT_SLAB",
        amount: draft.amount.trim(),
        minWeightGrams: draft.minWeight.trim() === "" ? 0 : Number(draft.minWeight),
        maxWeightGrams: draft.maxWeight.trim() === "" ? null : Number(draft.maxWeight),
      };
    }
    return { ruleType: draft.ruleType, amount: draft.amount.trim() };
  });
}

const SERVER_FIELD_TO_DRAFT: Record<string, DraftField> = {
  ruleType: "ruleType",
  basisPoints: "percent",
  amount: "amount",
  minWeightGrams: "minWeight",
  maxWeightGrams: "maxWeight",
};

/**
 * Puts the server's field errors ("rules.2.amount") back on the right row of the form.
 * Anything that does not belong to a row is returned as `other`.
 */
export function placeServerErrors(
  drafts: readonly DraftRule[],
  fieldErrors: Record<string, string>,
): { rows: DraftErrors; other: string[] } {
  const rows: DraftErrors = {};
  const other: string[] = [];
  for (const [path, message] of Object.entries(fieldErrors)) {
    const match = /^rules\.(\d+)\.(\w+)$/.exec(path);
    const draft = match ? drafts[Number(match[1])] : undefined;
    const field = match ? SERVER_FIELD_TO_DRAFT[match[2] ?? ""] : undefined;
    if (draft && field) rows[draft.key] = { ...rows[draft.key], [field]: message };
    else other.push(message);
  }
  return { rows, other };
}
