import { api } from "../../lib/api-client";

// These mirror the API's responses (apps/api/src/modules/rate-cards). Money is text ("60.00").

export type RuleType = "COMMISSION" | "FIXED_FEE" | "FREIGHT_SLAB" | "COD_FEE" | "REVERSE_FREIGHT";

export type PaymentType = "COD" | "PREPAID";

export interface RateRule {
  id: string;
  ruleType: RuleType;
  appliesToPayment: PaymentType | null;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  /** COMMISSION only. 2000 means 20%. */
  basisPoints: number | null;
  /** Every other fee, in rupees as text. */
  amount: string | null;
}

export interface RateCard {
  id: string;
  channel: { id: string; name: string };
  courier: { id: string; name: string } | null;
  versionNo: number;
  status: "ACTIVE" | "SUPERSEDED";
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isSampleData: boolean;
  note: string | null;
  createdAt: string;
  createdByName: string;
  rules: RateRule[];
}

/** One fee as the API wants it when saving. */
export interface RuleInput {
  ruleType: RuleType;
  basisPoints?: number;
  amount?: string;
  minWeightGrams?: number | null;
  maxWeightGrams?: number | null;
}

export interface SaveCardInput {
  note?: string | null;
  isSampleData?: boolean;
  rules: RuleInput[];
}

export interface CreateCardInput extends SaveCardInput {
  channelSourceId: string;
  courierSourceId?: string | null;
}

export interface CalculateInput {
  rateCardId: string;
  paymentType: PaymentType;
  orderValue: string;
  weightGrams?: number | null;
  isReturn: boolean;
}

export type CalculateResult =
  | {
      ok: true;
      rateCardId: string;
      versionNo: number;
      expected: string;
      lines: { label: string; amount: string }[];
    }
  | { ok: false; rateCardId: string; code: string; message: string };

export const RATE_CARDS_KEY = ["rate-cards"] as const;

export async function listRateCards(
  includeOlder: boolean,
  signal?: AbortSignal,
): Promise<RateCard[]> {
  const response = await api.get<{ items: RateCard[] }>("/rate-cards", {
    query: { includeOlder },
    signal,
  });
  return response.items;
}

export function createRateCard(input: CreateCardInput): Promise<RateCard> {
  return api.post<RateCard>("/rate-cards", input);
}

/** Saving an edit makes a new version of the card. The old version is kept. */
export function saveNewVersion(id: string, input: SaveCardInput): Promise<RateCard> {
  return api.put<RateCard>(`/rate-cards/${id}`, input);
}

export function calculateExpected(input: CalculateInput): Promise<CalculateResult> {
  return api.post<CalculateResult>("/rate-cards/calculate", input);
}
