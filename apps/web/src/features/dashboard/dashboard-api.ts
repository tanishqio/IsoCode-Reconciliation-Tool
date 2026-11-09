import { api } from "../../lib/api-client";

// These mirror the API's responses (apps/api/src/modules/dashboard and modules/audit).
// Money is text in rupees ("1234.50"). Dates are ISO text.

export interface AgeBand {
  key: string;
  label: string;
  fromDays: number;
  /** Null for the last, open-ended band. */
  toDays: number | null;
}

export interface TypeFigures {
  orders: number;
  amount: string;
}

export interface RiskFigures {
  cashAtRisk: string;
  orders: number;
  byType: {
    shortPaid: TypeFigures;
    unpaidPastDue: TypeFigures;
    freightOvercharged: TypeFigures;
  };
  /** In the same order as `ageBuckets`. */
  byAge: { key: string; amount: string; orders: number }[];
  returnsNotReceived: { orders: number; orderValue: string };
}

export interface PartnerRisk extends RiskFigures {
  id: string;
  name: string;
  kind: string | null;
}

export interface MoneyAtRisk {
  hasResults: boolean;
  orderCount: number;
  asOf: string | null;
  computedAt: string | null;
  settingsAreSample: boolean;
  ageBuckets: AgeBand[];
  totals: RiskFigures;
  partners: PartnerRisk[];
  notIncluded: {
    pending: number;
    cannotCalculate: number;
    notTracked: number;
    overpaid: number;
    settled: number;
  };
}

export interface TaxPartner {
  id: string;
  name: string;
  kind: string;
  lines: number;
  tcs: string;
  tds: string;
  total: string;
}

export interface TaxSummary {
  month: string | null;
  /** Months that have settlement lines, newest first, as YYYY-MM. */
  months: string[];
  partners: TaxPartner[];
  totals: { lines: number; tcs: string; tds: string; total: string };
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  label: string;
  entityType: string;
  entityId: string | null;
  user: { id: string; name: string; role: string } | null;
  meta: Record<string, string | number | boolean | null>;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

export const MONEY_AT_RISK_KEY = ["dashboard", "money-at-risk"] as const;
export const TAX_SUMMARY_KEY = ["dashboard", "tax-summary"] as const;
export const AUDIT_KEY = ["audit"] as const;

export function fetchMoneyAtRisk(signal?: AbortSignal): Promise<MoneyAtRisk> {
  return api.get<MoneyAtRisk>("/dashboard/money-at-risk", { signal });
}

export function fetchTaxSummary(month: string | null, signal?: AbortSignal): Promise<TaxSummary> {
  return api.get<TaxSummary>("/dashboard/tax-summary", { query: { month }, signal });
}

export function fetchAudit(cursor: string | undefined, signal?: AbortSignal): Promise<AuditPage> {
  return api.get<AuditPage>("/audit", { query: { limit: 25, cursor }, signal });
}
