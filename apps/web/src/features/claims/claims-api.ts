import { api } from "../../lib/api-client";

// These mirror the API's responses (apps/api/src/modules/claims). Money is text in rupees.

export type ClaimStatus = "OPEN" | "EXPORTED" | "RECOVERED" | "CLOSED";
export type ClaimType = "SHORT_PAID" | "UNPAID" | "FREIGHT_OVERCHARGE" | "RETURN_NOT_RECEIVED";

export interface Claim {
  id: string;
  claimNo: number;
  label: string;
  partner: { id: string; name: string };
  status: ClaimStatus;
  itemCount: number;
  total: string;
  recovered: string;
  oldestAgeDays: number | null;
  exportedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface ClaimsPage {
  total: number;
  page: number;
  pageSize: number;
  items: Claim[];
}

interface Bucket {
  claims: number;
  orders: number;
  total: string;
  recovered: string;
}

export interface ClaimsSummary {
  asOf: string | null;
  open: Bucket;
  exported: Bucket;
  recovered: Bucket;
  closed: Bucket;
  job: {
    status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
    stage: string | null;
    progressPct: number;
    errorMessage: string | null;
    finishedAt: string | null;
  } | null;
}

export interface ClaimItem {
  id: string;
  orderPk: string;
  orderId: string;
  claimType: ClaimType;
  typeLabel: string;
  amount: string;
  ageDays: number;
  ageBasisDate: string;
}

export interface ClaimDetail {
  claim: Claim;
  byType: { type: ClaimType; label: string; orders: number; amount: string }[];
  page: number;
  pageSize: number;
  items: ClaimItem[];
}

export interface EvidenceLine {
  kind: string;
  partner: string | null;
  date: string | null;
  reference: string | null;
  amount: string | null;
  file: string;
  row: number;
}

export interface ClaimItemDetail {
  id: string;
  claimLabel: string;
  claimStatus: ClaimStatus;
  orderId: string;
  typeLabel: string;
  amount: string;
  ageDays: number;
  ageBasisDate: string;
  evidence: {
    order: {
      channel: string;
      courier: string | null;
      awb: string | null;
      orderDate: string;
      value: string;
      paymentType: string;
      deliveryStatus: string;
    };
    result: {
      expected: string | null;
      received: string | null;
      difference: string | null;
      rateCardVersion: number | null;
      rateCardIsSample: boolean | null;
      asOf: string;
    };
    working: { label: string; amount: string }[];
    received: { label: string; amount: string }[];
    lines: EvidenceLine[];
  };
}

export interface ExportResult {
  fileName: string;
  csv: string;
  itemCount: number;
  total: string;
  exportedAt: string | null;
  status: ClaimStatus;
}

export interface ClaimsQuery {
  status?: ClaimStatus | undefined;
  page: number;
}

export const CLAIMS_PAGE_SIZE = 25;
export const CLAIM_ITEMS_PAGE_SIZE = 50;

export const claimsKeys = {
  all: ["claims"] as const,
  list: (query: ClaimsQuery) => ["claims", "list", query] as const,
  summary: ["claims", "summary"] as const,
  detail: (id: string, page: number) => ["claims", "detail", id, page] as const,
  item: (id: string) => ["claims", "item", id] as const,
};

export const getClaimsSummary = (signal?: AbortSignal) =>
  api.get<ClaimsSummary>("/claims/summary", { signal });

export const listClaims = (query: ClaimsQuery, signal?: AbortSignal) =>
  api.get<ClaimsPage>("/claims", { query: { ...query, pageSize: CLAIMS_PAGE_SIZE }, signal });

export const getClaim = (id: string, page: number, signal?: AbortSignal) =>
  api.get<ClaimDetail>(`/claims/${id}`, {
    query: { page, pageSize: CLAIM_ITEMS_PAGE_SIZE },
    signal,
  });

export const getClaimItem = (id: string, signal?: AbortSignal) =>
  api.get<ClaimItemDetail>(`/claims/items/${id}`, { signal });

export const exportClaim = (id: string) => api.post<ExportResult>(`/claims/${id}/export`);

export const setClaimStatus = (
  id: string,
  body: { status: "RECOVERED" | "CLOSED"; recovered?: string },
) => api.post<{ id: string; status: ClaimStatus; recovered: string }>(`/claims/${id}/status`, body);

export const rebuildClaims = () => api.post<{ jobId: string }>("/claims/rebuild");
