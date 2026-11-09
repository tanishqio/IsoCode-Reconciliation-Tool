import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, Money, PageHeader, SelectField } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { FilterChip } from "../orders/FilterChip";
import { formatCount, formatDate, pageCount } from "../orders/orders-model";
import {
  acceptSuggestion,
  getQueue,
  getReviewSummary,
  lookAgain,
  rejectSuggestion,
  reviewKeys,
  type LineKind,
  type QueueItem,
  type QueueQuery,
  type QueueView,
  type Suggestion,
} from "./review-api";
import {
  KIND_LABELS,
  SUGGESTION_LIMIT_NOTE,
  describeLineIds,
  partnerLine,
  strength,
} from "./review-model";

/** The review queue: payment lines with no usable order ID, and the orders they might belong to. */
export function ReviewPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<QueueView>("suggested");
  const [kind, setKind] = useState<LineKind | "">("");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);

  const query: QueueQuery = { view, kind: kind || undefined, page };
  const summary = useQuery({
    queryKey: reviewKeys.summary,
    queryFn: ({ signal }) => getReviewSummary(signal),
    refetchInterval: (state) =>
      state.state.data?.job?.status === "QUEUED" || state.state.data?.job?.status === "RUNNING"
        ? 1500
        : false,
  });
  const queue = useQuery({
    queryKey: reviewKeys.queue(query),
    queryFn: ({ signal }) => getQueue(query, signal),
    placeholderData: (previous) => previous,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
    void queryClient.invalidateQueries({ queryKey: ["claims"] });
  };
  const accept = useMutation({
    mutationFn: acceptSuggestion,
    onSuccess: (_result, id) => {
      const order = queue.data?.items.flatMap((item) => item.suggestions).find((s) => s.id === id);
      setNotice(
        `Linked to ${order?.order.orderId ?? "the order"}. Order results are being recalculated.`,
      );
      refresh();
    },
  });
  const reject = useMutation({
    mutationFn: rejectSuggestion,
    onSuccess: () => {
      setNotice("Suggestion rejected. It will not be offered again.");
      refresh();
    },
  });
  const again = useMutation({
    mutationFn: lookAgain,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: reviewKeys.all }),
  });

  const data = summary.data;
  const running = data?.job?.status === "QUEUED" || data?.job?.status === "RUNNING";
  const pages = pageCount(queue.data?.total ?? 0, queue.data?.pageSize ?? 20);
  const busy = accept.isPending || reject.isPending;
  const error = accept.error ?? reject.error;

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Payment lines the app could not place by their order ID. Check each suggestion. Nothing is matched until you accept it."
      />

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-cell text-muted" aria-live="polite">
            {running
              ? `Looking for suggestions\u2026 ${data?.job?.progressPct ?? 0}%`
              : data
                ? `${formatCount(data.unmatched)} line${data.unmatched === 1 ? "" : "s"} not matched. ${formatCount(data.accepted)} accepted and ${formatCount(data.rejected)} rejected so far.`
                : "\u00A0"}
          </p>
          <Button
            variant="secondary"
            disabled={again.isPending || running}
            onClick={() => again.mutate()}
          >
            Look for suggestions again
          </Button>
        </div>
        {data?.job?.status === "FAILED" ? (
          <p role="alert" className="text-cell text-risk">
            The last search failed: {data.job.errorMessage ?? "unknown reason"}
          </p>
        ) : null}
        <p className="text-label text-muted">{SUGGESTION_LIMIT_NOTE}</p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Which lines">
            <FilterChip
              active={view === "suggested"}
              onClick={() => {
                setView("suggested");
                setPage(1);
              }}
            >
              To review {data ? formatCount(data.withSuggestions) : ""}
            </FilterChip>
            <FilterChip
              active={view === "none"}
              onClick={() => {
                setView("none");
                setPage(1);
              }}
            >
              No candidate found {data ? formatCount(data.withoutCandidates) : ""}
            </FilterChip>
          </div>
          <SelectField
            label="Kind of line"
            placeholder="All kinds"
            value={kind}
            options={(Object.keys(KIND_LABELS) as LineKind[]).map((key) => ({
              value: key,
              label: KIND_LABELS[key],
            }))}
            onChange={(event) => {
              setKind(event.target.value as LineKind | "");
              setPage(1);
            }}
            className="w-56"
          />
        </div>

        {notice ? (
          <p
            role="status"
            className="rounded-ui border border-border bg-surface p-3 text-cell text-ink-2"
          >
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-cell text-risk">
            {getErrorMessage(error)}
          </p>
        ) : null}

        {queue.isPending ? (
          <LoadingState label={"Loading the queue\u2026"} rows={4} />
        ) : queue.isError ? (
          <ErrorState
            message={getErrorMessage(queue.error)}
            requestId={isApiError(queue.error) ? queue.error.requestId : undefined}
            onRetry={() => void queue.refetch()}
          />
        ) : queue.data.items.length === 0 ? (
          <EmptyState
            title={view === "suggested" ? "Nothing to review" : "No unplaced lines"}
            description={
              view === "suggested"
                ? "Every payment line has been matched by its ID, or no order looks like a match."
                : "Every payment line is matched or has a suggestion waiting."
            }
          />
        ) : (
          <>
            <ul className="flex flex-col gap-4">
              {queue.data.items.map((item) => (
                <LineCard
                  key={item.key}
                  item={item}
                  busy={busy}
                  onAccept={(id) => accept.mutate(id)}
                  onReject={(id) => reject.mutate(id)}
                />
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-cell text-muted">
                {formatCount(queue.data.total)} line{queue.data.total === 1 ? "" : "s"}, page {page}{" "}
                of {formatCount(pages)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={page >= pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function LineCard({
  item,
  busy,
  onAccept,
  onReject,
}: {
  item: QueueItem;
  busy: boolean;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <li className="rounded-ui border border-border">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface p-3">
        <div className="min-w-0">
          <p className="text-body font-medium text-ink">
            {partnerLine(item.lineKind, item.partner)}
          </p>
          <p className="text-cell text-ink-2">
            {item.date ? formatDate(item.date) : "No date"} &middot;{" "}
            {describeLineIds(item.orderIdOnLine, item.awb)}
          </p>
          <p className="break-all text-label text-muted">
            {item.file}, row {item.row}
          </p>
        </div>
        {item.amount !== null ? (
          <p className="text-body font-medium">
            <Money amount={item.amount} />
          </p>
        ) : null}
      </div>

      {item.suggestions.length === 0 ? (
        <p className="p-3 text-cell text-muted">
          No order looks like a match for this line. It stays unmatched; check the partner's file or
          the order file.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {item.suggestions.map((suggestion) => (
            <SuggestionRow
              key={suggestion.id}
              suggestion={suggestion}
              busy={busy}
              onAccept={() => onAccept(suggestion.id)}
              onReject={() => onReject(suggestion.id)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function SuggestionRow({
  suggestion,
  busy,
  onAccept,
  onReject,
}: {
  suggestion: Suggestion;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { order } = suggestion;
  const level = strength(suggestion.score);
  return (
    <li className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium text-ink">{order.orderId}</span>
          <Badge variant={level.variant}>{level.label}</Badge>
          <Badge>
            {suggestion.origin === "AI"
              ? `AI ranked${suggestion.aiModel ? ` (${suggestion.aiModel})` : ""}`
              : "Rules"}
          </Badge>
        </div>
        <p className="text-cell text-ink-2">
          {order.channel}
          {order.courier ? ` with ${order.courier}` : ""} &middot; ordered{" "}
          {formatDate(order.orderDate)} &middot; value <Money amount={order.value} />
          {order.expected !== null ? (
            <>
              {" "}
              &middot; expected <Money amount={order.expected} />
            </>
          ) : null}
        </p>
        <ul className="mt-1 list-disc pl-5 text-cell text-muted">
          {suggestion.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={onAccept}
          aria-label={`Accept ${order.orderId}`}
        >
          Accept
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={onReject}
          aria-label={`Reject ${order.orderId}`}
        >
          Reject
        </Button>
      </div>
    </li>
  );
}
