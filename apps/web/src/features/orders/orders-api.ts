import { api } from "../../lib/api-client";

// These mirror the API's responses (apps/api/src/modules/reconciliation).
// Money is text in rupees ("1409.00"); a loss is negative.

export type OrderStatus =
  | "SETTLED"
  | "SHORT_PAID"
  | "OVERPAID"
  | "UNPAID_PAST_DUE"
  | "FREIGHT_OVERCHARGED"
  | "RETURN_NOT_RECEIVED"
  | "PENDING"
  | "NOT_TRACKED"
  | "CANNOT_CALCULATE";

export type SortKey = "difference" | "orderDate";

export interface OrderRow {
  id: string;
  orderId: string;
  channel: string;
  courier: string | null;
  orderDate: string;
  value: string;
  paymentType: "COD" | "PREPAID";
  deliveryStatus: string;
  expected: string | null;
  received: string | null;
  difference: string | null;
  status: OrderStatus;
  flags: string[];
}

export interface OrdersPage {
  total: number;
  page: number;
  pageSize: number;
  items: OrderRow[];
}

export interface OrdersSummary {
  total: number;
  matched: number;
  channels: { id: string; name: string }[];
  byStatus: Partial<Record<OrderStatus, { count: number; difference: string }>>;
}

export interface ReconciliationStatus {
  job: {
    status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
    stage: string | null;
    progressPct: number;
    errorMessage: string | null;
    finishedAt: string | null;
  } | null;
  computedAt: string | null;
  asOf: string | null;
  orderCount: number;
  settings: {
    tolerance: string;
    codDueDays: number;
    settlementDueDays: number;
    returnWindowDays: number;
    isSampleData: boolean;
  };
}

export interface Amount {
  label: string;
  amount: string;
}

export interface OrderDetail {
  order: {
    id: string;
    orderId: string;
    channel: string;
    courier: string | null;
    orderDate: string;
    deliveredAt: string | null;
    returnedAt: string | null;
    value: string;
    paymentType: "COD" | "PREPAID";
    deliveryStatus: string;
    awb: string | null;
    weightGrams: number | null;
  };
  result: {
    status: OrderStatus;
    flags: string[];
    calcProblem: string | null;
    expected: string | null;
    received: string | null;
    difference: string | null;
    freightExpected: string | null;
    freightBilled: string;
    rateCard: { id: string; versionNo: number; isSampleData: boolean } | null;
    dueDate: string | null;
    asOf: string;
    computedAt: string;
    matchMethod: "EXACT" | "NONE";
  };
  working: Amount[];
  received: Amount[];
  lines: {
    settlement: {
      id: string;
      partner: string;
      date: string;
      type: string;
      amount: string;
      tcs: string;
      tds: string;
      file: string;
      row: number;
    }[];
    codRemittance: {
      id: string;
      partner: string;
      date: string;
      reference: string | null;
      amount: string;
      file: string;
      row: number;
    }[];
    freight: {
      id: string;
      partner: string;
      date: string | null;
      invoiceNo: string;
      chargeType: string;
      amount: string;
      file: string;
      row: number;
    }[];
    returnScans: { id: string; date: string; file: string; row: number }[];
  };
}

export interface OrdersQuery {
  status?: OrderStatus | undefined;
  channelId?: string | undefined;
  q?: string | undefined;
  sort: SortKey;
  page: number;
}

export const ORDERS_PAGE_SIZE = 50;

export const ordersKeys = {
  list: (query: OrdersQuery) => ["orders", "list", query] as const,
  summary: ["orders", "summary"] as const,
  detail: (id: string) => ["orders", "detail", id] as const,
  status: ["orders", "status"] as const,
};

export function listOrders(query: OrdersQuery, signal?: AbortSignal): Promise<OrdersPage> {
  return api.get<OrdersPage>("/orders", {
    query: { ...query, pageSize: ORDERS_PAGE_SIZE },
    signal,
  });
}

export const getSummary = (signal?: AbortSignal) =>
  api.get<OrdersSummary>("/orders/summary", { signal });

export const getOrder = (id: string, signal?: AbortSignal) =>
  api.get<OrderDetail>(`/orders/${id}`, { signal });

export const getStatus = (signal?: AbortSignal) =>
  api.get<ReconciliationStatus>("/reconciliation/status", { signal });

export const recalculate = () =>
  api.post<{ jobId: string; alreadyQueued: boolean }>("/reconciliation/run");
