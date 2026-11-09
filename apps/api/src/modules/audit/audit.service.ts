import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

// The audit trail: who did what, and to which record. Append only (this file never updates or
// deletes). It stores ids, codes and counts. It must never hold customer data, file names, e-mail
// addresses or text typed by a person, so every `meta` goes through sanitizeMeta first.

export const AUDIT_ACTIONS = [
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT",
  "UPLOAD",
  "DUPLICATE_BLOCKED",
  "MAPPING_APPROVED",
  "MAPPING_REJECTED",
  "MAPPING_ROLLED_BACK",
  "RATE_CARD_CREATED",
  "RATE_CARD_CHANGED",
  "RECONCILIATION_RUN",
  "MATCH_ACCEPTED",
  "MATCH_REJECTED",
  "CLAIM_EXPORTED",
  "CLAIM_STATUS_CHANGED",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_LABELS: Record<AuditAction, string> = {
  LOGIN: "Signed in",
  LOGIN_FAILED: "Failed sign-in",
  LOGOUT: "Signed out",
  UPLOAD: "Uploaded a file",
  DUPLICATE_BLOCKED: "Duplicate file blocked",
  MAPPING_APPROVED: "Approved a column mapping",
  MAPPING_REJECTED: "Rejected a column mapping",
  MAPPING_ROLLED_BACK: "Rolled back a column mapping",
  RATE_CARD_CREATED: "Created a rate card",
  RATE_CARD_CHANGED: "Changed a rate card",
  RECONCILIATION_RUN: "Recalculated order results",
  MATCH_ACCEPTED: "Accepted a suggested match",
  MATCH_REJECTED: "Rejected a suggested match",
  CLAIM_EXPORTED: "Exported claim evidence",
  CLAIM_STATUS_CHANGED: "Changed the status of a claim",
};

export interface AuditEvent {
  /** Null for a failed sign-in. */
  userId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

/** Writes one event. Never throws: a failed audit write is logged and must not break the action. */
export type AuditRecorder = (event: AuditEvent) => Promise<void>;

export type AuditMeta = Record<string, string | number | boolean | null>;

// Keys that could carry a secret, a customer detail or free text are dropped, whatever the caller sends.
const SENSITIVE_KEY =
  /pass|secret|token|csrf|cookie|authoriz|api.?key|email|phone|mobile|address|name|customer|snippet|content|body|note|comment/i;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const EMAIL_LIKE = /\S+@\S+\.\S+/;
const MAX_KEYS = 20;
const MAX_TEXT = 200;

/** Keeps only short, plain values under harmless keys. Anything else is silently left out. */
export function sanitizeMeta(meta: Record<string, unknown> | undefined): AuditMeta {
  const clean: AuditMeta = {};
  if (!meta) return clean;
  for (const [key, value] of Object.entries(meta)) {
    if (Object.keys(clean).length >= MAX_KEYS) break;
    if (!SAFE_KEY.test(key) || SENSITIVE_KEY.test(key)) continue;
    if (value === null || typeof value === "boolean") {
      clean[key] = value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) clean[key] = value;
    } else if (typeof value === "string") {
      if (!EMAIL_LIKE.test(value)) clean[key] = value.slice(0, MAX_TEXT);
    }
  }
  return clean;
}

export const listAuditQuerySchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
});

export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

export interface AuditEntryDto {
  id: string;
  createdAt: string;
  action: string;
  label: string;
  entityType: string;
  entityId: string | null;
  user: { id: string; name: string; role: string } | null;
  meta: AuditMeta;
}

export interface AuditPage {
  items: AuditEntryDto[];
  nextCursor: string | null;
}

export function encodeAuditCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeAuditCursor(value: string): { createdAt: Date; id: string } {
  const invalid = new AppError("VALIDATION_FAILED", 422, "The cursor is not valid.");
  const [isoText, id, ...rest] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (!isoText || !id || rest.length > 0) throw invalid;
  const createdAt = new Date(isoText);
  if (Number.isNaN(createdAt.getTime()) || !z.uuid().safeParse(id).success) throw invalid;
  return { createdAt, id };
}

export type AuditService = ReturnType<typeof createAuditService>;

export function createAuditService({ prisma }: { prisma: PrismaClient }) {
  const record: AuditRecorder = async (event) => {
    try {
      await prisma.auditLog.create({
        data: {
          userId: event.userId ?? null,
          action: event.action,
          entityType: event.entityType.slice(0, 60),
          entityId: event.entityId ?? null,
          meta: sanitizeMeta(event.meta),
        },
      });
    } catch (err) {
      logger.error({ err, action: event.action }, "audit write failed");
    }
  };

  async function list(query: ListAuditQuery): Promise<AuditPage> {
    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : undefined;
    const rows = await prisma.auditLog.findMany({
      where: {
        action: query.action,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      include: { user: { select: { id: true, name: true, role: true } } },
    });

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        action: row.action,
        label: AUDIT_LABELS[row.action as AuditAction] ?? row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        user: row.user,
        meta: sanitizeMeta(row.meta as Record<string, unknown>),
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeAuditCursor(last.createdAt, last.id) : null,
    };
  }

  return { record, list };
}
