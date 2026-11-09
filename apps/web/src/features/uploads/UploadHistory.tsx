import { useInfiniteQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, cn } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { listUploads, UPLOADS_KEY } from "./uploads-api";
import { FILE_TYPE_LABELS, STATUS_LABELS, formatBytes, formatDateTime } from "./uploads-model";

const th =
  "h-9 whitespace-nowrap border-b border-border-strong bg-page px-3 text-label font-medium uppercase tracking-wider text-muted";
const td = "h-10 whitespace-nowrap border-b border-border px-3 text-cell group-hover:bg-surface";
const stickyFirst =
  "max-sm:sticky max-sm:left-0 max-sm:border-r max-sm:border-r-border max-sm:bg-page";

export function UploadHistory() {
  const query = useInfiniteQuery({
    queryKey: UPLOADS_KEY,
    queryFn: ({ pageParam, signal }) => listUploads(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
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
            <table className="w-full min-w-[860px] border-collapse">
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
                    Uploaded
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
                    <td className={td}>{formatDateTime(file.uploadedAt)}</td>
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
    </section>
  );
}
