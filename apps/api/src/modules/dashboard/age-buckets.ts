// The age bands of the money-at-risk view.
//
// ASSUMPTION: the assignment asks for money at risk "by partner and age" but gives no bands. These
// four (up to 30, 31 to 60, 61 to 90, over 90 days) are a common choice for receivables ageing and
// are labelled as an assumption on screen and in docs/decisions.md. Change them here only.
//
// Age is counted from the date the money was due (or, when the result has no due date, from the
// delivery date, then the order date) up to the "as of" date of the results, which is the newest
// date in the uploaded data, not today.

export interface AgeBucket {
  key: string;
  label: string;
  fromDays: number;
  /** Null for the last, open-ended band. */
  toDays: number | null;
}

/** Upper limit (in days, included) of every band except the last. */
export const AGE_BUCKET_LIMITS = [30, 60, 90] as const;

export const AGE_BUCKETS: readonly AgeBucket[] = [
  { key: "0-30", label: "0 to 30 days", fromDays: 0, toDays: 30 },
  { key: "31-60", label: "31 to 60 days", fromDays: 31, toDays: 60 },
  { key: "61-90", label: "61 to 90 days", fromDays: 61, toDays: 90 },
  { key: "90+", label: "Over 90 days", fromDays: 91, toDays: null },
];

/** Which band a number of days falls in. Negative or fractional days count as 0. */
export function bucketIndexForDays(days: number): number {
  const whole = Math.max(0, Math.floor(days));
  const index = AGE_BUCKET_LIMITS.findIndex((limit) => whole <= limit);
  return index === -1 ? AGE_BUCKET_LIMITS.length : index;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `anchor` to `asOf`, by calendar date in UTC. Never negative. */
export function ageInDays(asOf: Date, anchor: Date): number {
  const dayOf = (date: Date) => Math.floor(date.getTime() / DAY_MS);
  return Math.max(0, dayOf(asOf) - dayOf(anchor));
}
