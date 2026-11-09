import { api } from "../../lib/api-client";

// These mirror the API's responses (apps/api/src/modules/returns). Money is text in rupees.

export type ReturnState = "RECEIVED" | "NOT_RECEIVED" | "WAITING";

export interface ReturnRow {
  id: string;
  orderId: string;
  channel: string;
  courier: string | null;
  awb: string | null;
  value: string;
  deliveryStatus: string;
  returnedAt: string | null;
  returnStart: string;
  windowEnds: string;
  daysSince: number;
  scannedAt: string | null;
  state: ReturnState;
}

export interface ReturnsPage {
  windowDays: number;
  total: number;
  page: number;
  pageSize: number;
  items: ReturnRow[];
}

export interface ReturnsSummary {
  windowDays: number;
  asOf: string | null;
  notReceived: { orders: number; value: string };
  waiting: { orders: number; value: string };
  received: { orders: number; value: string };
}

export interface ReturnsQuery {
  state?: ReturnState | undefined;
  q?: string | undefined;
  page: number;
}

export const RETURNS_PAGE_SIZE = 50;

export const returnsKeys = {
  list: (query: ReturnsQuery) => ["returns", "list", query] as const,
  summary: ["returns", "summary"] as const,
};

export const listReturns = (query: ReturnsQuery, signal?: AbortSignal) =>
  api.get<ReturnsPage>("/returns", { query: { ...query, pageSize: RETURNS_PAGE_SIZE }, signal });

export const getReturnsSummary = (signal?: AbortSignal) =>
  api.get<ReturnsSummary>("/returns/summary", { signal });
