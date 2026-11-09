import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, cn } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { ProcessButton } from "./ProcessButton";
import { RejectedRowsDialog } from "./RejectedRowsDialog";
import { listUploads, UPLOADS_KEY, type UploadedFile } from "./uploads-api";
import {
  FILE_TYPE_LABELS,
  STATUS_LABELS,
  canProcess,
  formatBytes,
  formatCount,
  formatDateTime,
  isInProgress,
  needsMapping,
  progressLabel,
} from "./uploads-model";

/** How often the list refreshes while a file is waiting for or being read by the worker. */
const REFRESH_WHILE_ACTIVE_MS = 1500;

const th =
  "h-9 whitespace-nowrap border-b border-border-strong bg-page px-3 text-label font-medium uppercase tracking-wider text-muted";
const td = "h-10 whitespace-nowrap border-b border-border px-3 text-cell group-hover:bg-surface";
const stickyFirst =
  "max-sm:sticky max-sm:left-0 max-sm:border-r max-sm:border-r-border max-sm:bg-page";

export function UploadHistory() {
  const [viewing, setViewing] = useState<UploadedFile | null>(null);
  const query = useInfiniteQuery({
    queryKey: UPLOADS_KEY,
    queryFn: ({ pageParam, signal }) => listUploads(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (q) =>
      q.state.data?.pages.some((page) => page.items.some(isInProgress))
        ? REFRESH_WHILE_ACTIVE_MS
        : false,
  });

  const files = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading" className="mb-3 text-section font-semibold text-ink">
        Uploaded files
      </h2>

      {query.isPending ? (
        <LoadingState label={"Loading uploaded files\u2026"} rows={4} />
      ) : query.isError ? (
        <ErrorState
          message={getErrorMessage(query.error)}
          requestId={isApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : files.length === 0 ? (
        <EmptyState
          title="No files uploaded yet"
          description="Choose files above to upload your first report."
        />
      ) : (
        <>
          <div className="max-h-[32rem] overflow-auto border-t border-border-strong">
            <table className="w-full min-w-[1100px] border-collapse">
              <thead>
                <tr className="text-left">
                  <th scope="col" className={cn(th, "sticky top-0 z-10", stickyFirst)}>
                    File
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0")}>
                    Source
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0")}>
                    Type
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0")}>
                    Format
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                    Size
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                    Rows
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0")}>
                    Status
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0")}>
                    Result
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0")}>
                    Uploaded
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0")}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id} className="group">
                    <td
                      className={cn(td, stickyFirst, "max-w-72 truncate font-medium")}
                      title={file.originalName}
                    >
                      {file.originalName}
                    </td>
                    <td className={td}>{file.sourceName}</td>
                    <td className={td}>{FILE_TYPE_LABELS[file.fileType]}</td>
                    <td className={td}>{file.format}</td>
                    <td className={cn(td, "text-right")}>{formatBytes(file.sizeBytes)}</td>
                    <td className={cn(td, "text-right")}>
                      {file.detectedRowCount === null ? "\u2014" : file.detectedRowCount}
                    </td>
                    <td className={td}>
                      <Badge variant={file.status === "NEEDS_MAPPING" ? "accent" : "neutral"}>
                        {STATUS_LABELS[file.status]}
                      </Badge>
                    </td>
                    <td className={cn(td, "max-w-80")}>
                      <ResultCell file={file} />
                    </td>
                    <td className={td}>{formatDateTime(file.uploadedAt)}</td>
                    <td className={cn(td, "h-auto py-2")}>
                      <div className="flex items-center gap-2">
                        {needsMapping(file) ? (
                          <Button asChild variant="primary">
                            <Link to={`/sources/${file.sourceId}/mapping?file=${file.id}`}>
                              Review mapping
                            </Link>
                          </Button>
                        ) : null}
                        {canProcess(file) ? <ProcessButton file={file} /> : null}
                        {(file.rowsRejected ?? 0) > 0 ? (
                          <Button variant="secondary" onClick={() => setViewing(file)}>
                            View rejected
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {query.hasNextPage ? (
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? "Loading\u2026" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <RejectedRowsDialog file={viewing} onClose={() => setViewing(null)} />
    </section>
  );
}

/** What happened to a file: progress while it runs, the counts when it is done, or the failure. */
function ResultCell({ file }: { file: UploadedFile }) {
  if (isInProgress(file)) {
    return <span className="text-ink-2">{progressLabel(file)}</span>;
  }
  if (file.status === "FAILED") {
    return (
      <span className="block truncate text-ink-2" title={file.job?.errorMessage ?? undefined}>
        {file.job?.errorMessage ?? "Processing failed."}
      </span>
    );
  }
  if (file.rowsAccepted === null) {
    return <span className="text-muted">Not processed yet</span>;
  }
  return (
    <span className="tabular-nums text-ink-2">
      {formatCount(file.rowsAccepted)} saved
      {(file.rowsRejected ?? 0) > 0 ? `, ${formatCount(file.rowsRejected)} rejected` : ""}
      {(file.rowsDuplicate ?? 0) > 0 ? `, ${formatCount(file.rowsDuplicate)} duplicate` : ""}
    </span>
  );
}
