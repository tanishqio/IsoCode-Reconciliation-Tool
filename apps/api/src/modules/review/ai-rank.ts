import { z } from "zod";
import { AiUnavailableError, requestAiJson, type AiConfig } from "../mapping/ai-client.js";

// For the few lines where the rules cannot tell two candidates apart, the AI is asked to pick one.
// It sees only amounts, dates and IDs of orders and payments (business data, never customer data),
// a batch of cases per call, and never decides anything: its pick only raises the score of one
// suggestion, which a person still accepts or rejects.

export const BATCH_SIZE = 25;
const MAX_REASON = 160;

export interface RankCase {
  key: string;
  kind: string;
  amount: string | null;
  date: string | null;
  orderIdOnLine: string | null;
  candidates: {
    index: number;
    orderId: string;
    orderValue: string;
    expectedAmount: string | null;
    orderDate: string;
    ruleScore: number;
  }[];
}

export interface RankPick {
  key: string;
  /** Index of the chosen candidate. */
  index: number;
  confidence: "high" | "medium" | "low";
  reason: string;
}

const answerSchema = z.object({
  results: z.array(
    z.object({
      key: z.string(),
      pick: z.number().int().nullable(),
      confidence: z.enum(["high", "medium", "low"]).catch("low"),
      reason: z.string().optional(),
    }),
  ),
});

const SYSTEM_PROMPT =
  "You help a finance team match a payment line to the order it belongs to when the order ID is " +
  "missing or wrong. For each case, pick the candidate that most likely owns the line, using only " +
  "the amounts, dates and IDs given. If you are not sure, set pick to null. Never guess. " +
  'Reply with JSON only: {"results":[{"key":"<case key>","pick":<candidate index or null>,' +
  '"confidence":"high|medium|low","reason":"<one short sentence>"}]}.';

/**
 * Asks the AI to rank ambiguous cases. Returns only the picks that are valid (the case exists and
 * the index is one of its candidates). Throws AiUnavailableError if the service is not usable.
 */
export async function rankWithAi(
  config: AiConfig,
  cases: readonly RankCase[],
  fetchImpl: typeof fetch = fetch,
): Promise<RankPick[]> {
  const picks: RankPick[] = [];
  for (let from = 0; from < cases.length; from += BATCH_SIZE) {
    const batch = cases.slice(from, from + BATCH_SIZE);
    const json = await requestAiJson(config, SYSTEM_PROMPT, { cases: batch }, fetchImpl);
    const parsed = answerSchema.safeParse(json);
    if (!parsed.success) {
      throw new AiUnavailableError("The AI service sent an answer that could not be understood.");
    }
    const byKey = new Map(batch.map((entry) => [entry.key, entry]));
    for (const result of parsed.data.results) {
      const entry = byKey.get(result.key);
      if (!entry || result.pick === null) continue;
      if (!entry.candidates.some((candidate) => candidate.index === result.pick)) continue;
      picks.push({
        key: result.key,
        index: result.pick,
        confidence: result.confidence,
        reason: (result.reason ?? "").slice(0, MAX_REASON),
      });
    }
  }
  return picks;
}
