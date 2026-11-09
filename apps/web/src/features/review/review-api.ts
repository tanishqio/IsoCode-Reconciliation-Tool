import { api } from "../../lib/api-client";

// These mirror the API's responses (apps/api/src/modules/review). Money is text in rupees.

export type LineKind = "SETTLEMENT" | "COD_REMITTANCE" | "FREIGHT" | "RETURN_SCAN";
export type QueueView = "suggested" | "none";

export interface Suggestion {
  id: string;
  score: number;
  reasons: string[];
  origin: "RULES" | "AI";
  aiModel: string | null;
  order: {
    id: string;
    orderId: string;
    channel: string;
    courier: string | null;
    value: string;
    expected: string | null;
    orderDate: string;
    status: string | null;
  };
}

export interface QueueItem {
  key: string;
  lineKind: LineKind;
  lineId: string;
  partner: string;
  date: string | null;
  amount: string | null;
  orderIdOnLine: string | null;
  awb: string | null;
  file: string;
  row: number;
  suggestions: Suggestion[];
}

export interface Queue {
  view: QueueView;
  total: number;
  page: number;
  pageSize: number;
  items: QueueItem[];
}

export interface ReviewSummary {
  byKind: {
    kind: LineKind;
    unmatched: number;
    withSuggestions: number;
    withoutCandidates: number;
  }[];
  unmatched: number;
  withSuggestions: number;
  withoutCandidates: number;
  accepted: number;
  rejected: number;
  job: {
    status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
    stage: string | null;
    progressPct: number;
    errorMessage: string | null;
    finishedAt: string | null;
  } | null;
}

export interface QueueQuery {
  view: QueueView;
  kind?: LineKind | undefined;
  page: number;
}

export const REVIEW_PAGE_SIZE = 20;

export const reviewKeys = {
  all: ["review"] as const,
  queue: (query: QueueQuery) => ["review", "queue", query] as const,
  summary: ["review", "summary"] as const,
};

export const getReviewSummary = (signal?: AbortSignal) =>
  api.get<ReviewSummary>("/review/summary", { signal });

export const getQueue = (query: QueueQuery, signal?: AbortSignal) =>
  api.get<Queue>("/review/queue", { query: { ...query, pageSize: REVIEW_PAGE_SIZE }, signal });

export const acceptSuggestion = (id: string) =>
  api.post<{ id: string; orderPk: string; lineKind: LineKind }>(`/review/suggestions/${id}/accept`);

export const rejectSuggestion = (id: string) =>
  api.post<{ id: string }>(`/review/suggestions/${id}/reject`);

export const lookAgain = () => api.post<{ jobId: string }>("/review/run");
