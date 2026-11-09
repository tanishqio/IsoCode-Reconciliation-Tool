import { z } from "zod";

/** "2026-08" -> first day of that month as YYYY-MM-DD, or null for an invalid month. */
export function monthStart(month: string): string | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  return match ? `${match[1]}-${match[2]}-01` : null;
}

export const taxSummaryQuerySchema = z.object({
  /** Limits the summary to one month of settlement dates, for example 2026-08. Empty means all dates. */
  month: z
    .string()
    .refine((value) => monthStart(value) !== null, "Use the form YYYY-MM, for example 2026-08.")
    .optional(),
});

export type TaxSummaryQuery = z.infer<typeof taxSummaryQuerySchema>;
