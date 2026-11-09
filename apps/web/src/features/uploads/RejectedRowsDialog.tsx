import * as Dialog from "@radix-ui/react-dialog";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { listRejectedRows, type UploadedFile } from "./uploads-api";
import { formatCount, reasonLabel } from "./uploads-model";

/**
 * Lists the rows of one file that were not saved, with the spreadsheet row number and the reason,
 * so a person can fix the source file. Only the values of the mapped columns are shown.
 */
export function RejectedRowsDialog({
  file,
  onClose,
}: {
  file: UploadedFile | null;
  onClose: () => void;
}) {
  const fileId = file?.id;
  const query = useInfiniteQuery({
    queryKey: ["uploads", "rejected-rows", fileId],
    queryFn: ({ pageParam, signal }) => listRejectedRows(fileId as string, pageParam, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextAfter ?? undefined,
    enabled: fileId !== undefined,
  });

  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const reasons = query.data?.pages[0]?.reasons ?? [];

  return (
    <Dialog.Root open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-ui border border-border bg-page p-5 shadow-overlay">
          <Dialog.Title className="text-section font-semibold text-ink">Rejected rows</Dialog.Title>
          <Dialog.Description className="mt-1 break-all text-body text-ink-2">
            {file
              ? `${file.originalName}: ${formatCount(file.rowsRejected)} rows were not saved.`
              : ""}
          </Dialog.Description>

          {reasons.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {reasons.map((reason) => (
                <li key={reason.reasonCode}>
                  <Badge>
                    {reasonLabel(reason.reasonCode)}: {formatCount(reason.count)}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-4 min-h-0 flex-1 overflow-auto border-t border-border-strong">
            {query.isPending ? (
              <LoadingState label={"Loading rejected rows\u2026"} rows={4} />
            ) : query.isError ? (
              <ErrorState
                message={getErrorMessage(query.error)}
                requestId={isApiError(query.error) ? query.error.requestId : undefined}
                onRetry={() => void query.refetch()}
              />
            ) : (
              <table className="w-full min-w-[560px] border-collapse">
                <thead>
                  <tr className="text-left text-label font-medium uppercase tracking-wider text-muted">
                    <th
                      scope="col"
                      className="sticky top-0 border-b border-border-strong bg-page px-3 py-2"
                    >
                      Row
                    </th>
                    <th
                      scope="col"
                      className="sticky top-0 border-b border-border-strong bg-page px-3 py-2"
                    >
                      Problem
                    </th>
                    <th
                      scope="col"
                      className="sticky top-0 border-b border-border-strong bg-page px-3 py-2"
                    >
                      Values read
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="align-top">
                      <td className="border-b border-border px-3 py-2 text-cell tabular-nums">
                        {row.rowNumber}
                      </td>
                      <td className="border-b border-border px-3 py-2 text-cell">
                        <span className="block font-medium text-ink">
                          {reasonLabel(row.reasonCode)}
                        </span>
                        <span className="block text-muted">{row.message}</span>
                      </td>
                      <td className="max-w-64 break-words border-b border-border px-3 py-2 text-cell text-ink-2">
                        {row.rawSnippet ?? "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            {query.hasNextPage ? (
              <Button
                variant="secondary"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? "Loading\u2026" : "Load more"}
              </Button>
            ) : (
              <span />
            )}
            <Dialog.Close asChild>
              <Button variant="primary">Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
