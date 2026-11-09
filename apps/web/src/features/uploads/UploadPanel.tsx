import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { ErrorState, LoadingState } from "../../components/feedback";
import { Button, SelectField, cn } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { DuplicateDialog } from "./DuplicateDialog";
import { SOURCES_KEY, UPLOADS_KEY, listSources, uploadFiles } from "./uploads-api";
import type { FileResult, UploadOutcome } from "./uploads-api";
import {
  ACCEPTED_EXTENSIONS,
  FILE_TYPE_LABELS,
  MAX_FILES,
  addFiles,
  allowedFileTypes,
  canUpload,
  formatBytes,
  rowsAfterUpload,
  setRowSource,
  type DraftRow,
} from "./uploads-model";
import { UploadResults } from "./UploadResults";

export function UploadPanel() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null);
  const [dragging, setDragging] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);

  const sources = useQuery({
    queryKey: SOURCES_KEY,
    queryFn: ({ signal }) => listSources(signal),
    staleTime: 5 * 60_000,
  });
  const sourceList = sources.data ?? [];

  const upload = useMutation({
    mutationFn: () =>
      uploadFiles(
        rows.map((row) => ({
          file: row.file,
          sourceId: row.sourceId,
          fileType: row.fileType as Exclude<DraftRow["fileType"], "">,
        })),
      ),
    onSuccess: (result) => {
      setOutcome(result);
      // Files that were saved or removed as duplicates leave the list; rejected ones stay to be fixed.
      setRows((current) => rowsAfterUpload(current, result.results));
      setNotice(null);
      if (result.summary.duplicate > 0) setDuplicatesOpen(true);
      void queryClient.invalidateQueries({ queryKey: UPLOADS_KEY });
    },
  });

  const duplicates = (outcome?.results ?? []).filter(
    (result): result is Extract<FileResult, { status: "DUPLICATE" }> =>
      result.status === "DUPLICATE",
  );

  function choose(files: File[]) {
    if (files.length === 0) return;
    const added = addFiles(rows, files);
    setRows(added.rows);
    upload.reset();
    setOutcome(null);
    const problems: string[] = [];
    if (added.wrongType.length > 0) {
      problems.push(
        `Only ${ACCEPTED_EXTENSIONS.join(", ")} files are accepted: ${added.wrongType.join(", ")}.`,
      );
    }
    if (added.overflow > 0) {
      problems.push(
        `You can upload at most ${MAX_FILES} files at a time. ${added.overflow} not added.`,
      );
    }
    setNotice(problems.length > 0 ? problems.join(" ") : null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    choose(Array.from(event.dataTransfer.files));
  }

  const ready = canUpload(rows, sourceList);

  return (
    <section aria-labelledby="upload-heading" className="flex flex-col gap-4">
      <h2 id="upload-heading" className="text-section font-semibold text-ink">
        Upload files
      </h2>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-2 rounded-ui border border-dashed px-4 py-8 text-center",
          dragging ? "border-accent bg-accent-tint" : "border-border-strong bg-surface",
        )}
      >
        <p className="text-body text-ink">Drag files here, or choose them from your computer.</p>
        <p className="text-cell text-muted">
          {ACCEPTED_EXTENSIONS.join(", ")} &middot; up to {MAX_FILES} files at a time
        </p>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(",")}
          aria-label="Choose files to upload"
          className="sr-only"
          onChange={(event) => {
            choose(Array.from(event.target.files ?? []));
            event.target.value = ""; // so choosing the same file again still counts
          }}
        />
        <Button variant="secondary" onClick={() => fileInput.current?.click()}>
          Choose files
        </Button>
      </div>

      {notice ? (
        <p role="status" className="text-cell text-ink-2">
          {notice}
        </p>
      ) : null}

      {sources.isPending ? <LoadingState label={"Loading sources\u2026"} rows={2} /> : null}
      {sources.isError ? (
        <ErrorState
          message={getErrorMessage(sources.error)}
          requestId={isApiError(sources.error) ? sources.error.requestId : undefined}
          onRetry={() => void sources.refetch()}
        />
      ) : null}

      {rows.length > 0 && sources.isSuccess ? (
        <ul className="flex flex-col gap-3" aria-label="Files to upload">
          {rows.map((row) => {
            const allowed = allowedFileTypes(sourceList, row.sourceId);
            return (
              <li
                key={row.key}
                className="grid grid-cols-1 gap-3 rounded-ui border border-border p-3 sm:grid-cols-[minmax(0,1fr)_14rem_14rem_auto] sm:items-end"
              >
                <div className="min-w-0">
                  <p className="break-all text-cell font-medium text-ink">{row.file.name}</p>
                  <p className="text-label text-muted">{formatBytes(row.file.size)}</p>
                </div>
                <SelectField
                  label={`Source for ${row.file.name}`}
                  hideLabel
                  placeholder="Choose a source"
                  value={row.sourceId}
                  options={sourceList.map((source) => ({ value: source.id, label: source.name }))}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item) =>
                        item.key === row.key
                          ? setRowSource(item, sourceList, event.target.value)
                          : item,
                      ),
                    )
                  }
                />
                <SelectField
                  label={`File type for ${row.file.name}`}
                  hideLabel
                  placeholder="Choose a file type"
                  value={row.fileType}
                  disabled={row.sourceId === ""}
                  options={allowed.map((type) => ({ value: type, label: FILE_TYPE_LABELS[type] }))}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item) =>
                        item.key === row.key
                          ? { ...item, fileType: event.target.value as DraftRow["fileType"] }
                          : item,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.file.name}`}
                  onClick={() =>
                    setRows((current) => current.filter((item) => item.key !== row.key))
                  }
                >
                  <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {upload.isError ? (
        <ErrorState
          message={getErrorMessage(upload.error)}
          requestId={isApiError(upload.error) ? upload.error.requestId : undefined}
        />
      ) : null}

      {rows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={!ready || upload.isPending}
            onClick={() => upload.mutate()}
          >
            {upload.isPending
              ? "Uploading\u2026"
              : `Upload ${rows.length} file${rows.length === 1 ? "" : "s"}`}
          </Button>
          {!ready ? (
            <span className="text-cell text-muted">
              Choose a source and a file type for every file.
            </span>
          ) : null}
        </div>
      ) : null}

      {outcome ? <UploadResults outcome={outcome} /> : null}

      <DuplicateDialog
        duplicates={duplicates}
        open={duplicatesOpen}
        onOpenChange={setDuplicatesOpen}
      />
    </section>
  );
}
