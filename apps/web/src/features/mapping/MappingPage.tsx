import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, PageHeader, SelectField, cn } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { UPLOADS_KEY } from "../uploads/uploads-api";
import { FILE_TYPE_LABELS, formatDateTime } from "../uploads/uploads-model";
import {
  approveMapping,
  listMappingVersions,
  listWaitingFiles,
  mappingKeys,
  previewMapping,
  rejectProposal,
  rollbackMapping,
  suggestMapping,
  type ColumnMap,
  type MappingSuggestion,
  type Preview,
} from "./mapping-api";
import {
  ORIGIN_LABELS,
  canApprove,
  describeSource,
  duplicateColumns,
  missingRequired,
  needsCheck,
  setField,
} from "./mapping-model";

const th =
  "whitespace-nowrap border-b border-border-strong bg-page px-3 py-2 text-left text-label font-medium uppercase tracking-wider text-muted";
const td = "border-b border-border px-3 py-2 text-cell align-top";

export function MappingPage() {
  const { sourceId = "" } = useParams();
  const [search] = useSearchParams();
  const fileId = search.get("file");

  return (
    <>
      <PageHeader
        title="Mapping review"
        description="Check which column of the file feeds each field. Nothing is read until you approve."
      />
      {fileId ? <ReviewFile key={fileId} fileId={fileId} /> : <WaitingFiles sourceId={sourceId} />}
    </>
  );
}

function WaitingFiles({ sourceId }: { sourceId: string }) {
  const query = useQuery({
    queryKey: mappingKeys.waiting(sourceId),
    queryFn: ({ signal }) => listWaitingFiles(sourceId, signal),
  });
  if (query.isPending) return <LoadingState label={"Loading files\u2026"} rows={3} />;
  if (query.isError) {
    return (
      <ErrorState message={getErrorMessage(query.error)} onRetry={() => void query.refetch()} />
    );
  }
  if (query.data.items.length === 0) {
    return (
      <EmptyState
        title="No files are waiting for a mapping"
        description="A file waits here when its column names are new for this source."
        action={
          <Button asChild variant="secondary">
            <Link to="/uploads">Back to uploads</Link>
          </Button>
        }
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {query.data.items.map((file) => (
        <li
          key={file.id}
          className="flex items-center justify-between gap-3 rounded-ui border border-border p-3"
        >
          <span className="min-w-0 break-all text-cell">
            <span className="font-medium text-ink">{file.originalName}</span>{" "}
            <span className="text-muted">{FILE_TYPE_LABELS[file.fileType]}</span>
          </span>
          <Button asChild variant="primary">
            <Link to={`/sources/${sourceId}/mapping?file=${file.id}`}>Review mapping</Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ReviewFile({ fileId }: { fileId: string }) {
  const suggestion = useQuery({
    queryKey: mappingKeys.suggestion(fileId),
    queryFn: () => suggestMapping(fileId),
    // A suggestion is saved on the server each time it is asked for, so ask only once.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (suggestion.isPending) {
    return <LoadingState label={"Reading the file and suggesting a mapping\u2026"} rows={5} />;
  }
  if (suggestion.isError) {
    const conflict = isApiError(suggestion.error) && suggestion.error.status === 409;
    return (
      <ErrorState
        message={
          conflict
            ? "This file already has a mapping. Open the uploads list to see its result."
            : getErrorMessage(suggestion.error)
        }
        requestId={isApiError(suggestion.error) ? suggestion.error.requestId : undefined}
      />
    );
  }
  return <ReviewForm suggestion={suggestion.data} />;
}

function ReviewForm({ suggestion }: { suggestion: MappingSuggestion }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { file } = suggestion;
  const [columnMap, setColumnMap] = useState<ColumnMap>(suggestion.columnMap);
  const [preview, setPreview] = useState<Preview>(suggestion.preview);
  const [problems, setProblems] = useState<string[]>([]);
  const [changed, setChanged] = useState<Set<string>>(new Set());

  // Show the 20 rows again whenever the person changes a column.
  useEffect(() => {
    if (changed.size === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewMapping(file.id, columnMap, controller.signal)
        .then((result) => {
          setPreview(result.preview);
          setProblems(result.problems);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [columnMap, changed, file.id]);

  const approve = useMutation({
    mutationFn: () =>
      approveMapping({ fileId: file.id, proposalId: suggestion.proposalId, columnMap }),
    onSuccess: () => {
      // The suggestion is finished with. Dropping it (instead of refreshing it) avoids asking the
      // server for a suggestion on a file that now has a mapping.
      queryClient.removeQueries({ queryKey: mappingKeys.suggestion(file.id) });
      void queryClient.invalidateQueries({ queryKey: UPLOADS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["mapping", "versions"] });
      navigate("/uploads");
    },
  });
  const reject = useMutation({
    mutationFn: () => rejectProposal(suggestion.proposalId),
    onSuccess: () => navigate("/uploads"),
  });

  const usable = suggestion.headers.filter(
    (header) => header.trim() !== "" && !suggestion.ignoredColumns.includes(header),
  );
  const repeated = duplicateColumns(columnMap);
  const missing = missingRequired(suggestion.fields, columnMap);
  const ready = canApprove(suggestion.fields, columnMap, problems);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="source-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="source-heading" className="text-section font-semibold text-ink">
            {file.sourceName} &middot; {FILE_TYPE_LABELS[file.fileType]}
          </h2>
          <Badge variant="accent">
            {suggestion.origin === "AI" ? "AI suggestion" : "Rule-based suggestion"}
          </Badge>
          {suggestion.aiModel ? <Badge>{suggestion.aiModel}</Badge> : null}
        </div>
        <p className="break-all text-cell text-muted">{file.originalName}</p>
        {suggestion.activeVersion ? (
          <p className="text-cell text-ink-2">
            This source has a saved mapping (version {suggestion.activeVersion.versionNo}), but this
            file has different column names. Approving replaces it; you can roll back later.
          </p>
        ) : null}
        {suggestion.notes.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-ui border border-border bg-surface p-3 text-cell text-ink-2">
            {suggestion.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="fields-heading" className="flex flex-col gap-3">
        <h2 id="fields-heading" className="text-section font-semibold text-ink">
          Columns
        </h2>
        <div className="overflow-x-auto border-t border-border-strong">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr>
                <th scope="col" className={th}>
                  Field
                </th>
                <th scope="col" className={th}>
                  Column in the file
                </th>
                <th scope="col" className={th}>
                  Where it came from
                </th>
              </tr>
            </thead>
            <tbody>
              {suggestion.fields.map((field) => {
                const info = suggestion.fieldInfo[field.name];
                const mapped = columnMap[field.name] ?? "";
                const edited = changed.has(field.name);
                return (
                  <tr key={field.name}>
                    <td className={td}>
                      <span className="font-medium text-ink">{field.label}</span>{" "}
                      {field.required ? <Badge>Required</Badge> : null}
                    </td>
                    <td className={cn(td, "w-72")}>
                      <SelectField
                        label={`Column for ${field.label}`}
                        hideLabel
                        placeholder="Not mapped"
                        value={mapped}
                        options={usable.map((header) => ({ value: header, label: header }))}
                        onChange={(event) => {
                          setColumnMap((current) =>
                            setField(current, field.name, event.target.value),
                          );
                          setChanged((current) => new Set(current).add(field.name));
                        }}
                      />
                    </td>
                    <td className={td}>
                      <span
                        className={cn(
                          "text-ink-2",
                          !edited && mapped !== "" && needsCheck(info) && "font-medium text-ink",
                        )}
                      >
                        {mapped === "" ? "\u2014" : describeSource(info, edited)}
                      </span>
                      {!edited && mapped !== "" && needsCheck(info) ? (
                        <span className="block text-label text-muted">Please check this one.</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {suggestion.ignoredColumns.length > 0 ? (
          <p className="text-cell text-muted">
            Not used because they look like personal data: {suggestion.ignoredColumns.join(", ")}.
          </p>
        ) : null}
        {repeated.length > 0 ? (
          <p role="alert" className="text-cell text-risk">
            One column feeds two fields: {repeated.join(", ")}.
          </p>
        ) : null}
        {problems.length > 0 ? (
          <p role="alert" className="text-cell text-risk">
            {problems.join("; ")}.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="preview-heading" className="flex flex-col gap-3">
        <h2 id="preview-heading" className="text-section font-semibold text-ink">
          First {preview.rows.length} rows with this mapping
        </h2>
        <p className="text-cell text-muted">
          {preview.rowsWithProblems === 0
            ? "Every row shown can be read."
            : `${preview.rowsWithProblems} of these rows would be rejected. See the Problem column.`}
        </p>
        <div className="max-h-96 overflow-auto border-t border-border-strong">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr>
                <th scope="col" className={cn(th, "sticky top-0")}>
                  Row
                </th>
                {preview.fields.map((name) => (
                  <th key={name} scope="col" className={cn(th, "sticky top-0")}>
                    {suggestion.fields.find((field) => field.name === name)?.label ?? name}
                  </th>
                ))}
                <th scope="col" className={cn(th, "sticky top-0")}>
                  Problem
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr key={row.rowNumber}>
                  <td className={cn(td, "tabular-nums")}>{row.rowNumber}</td>
                  {preview.fields.map((name) => (
                    <td key={name} className={cn(td, "whitespace-nowrap")}>
                      {row.values[name] ?? "\u2014"}
                    </td>
                  ))}
                  <td className={cn(td, "text-ink-2")}>{row.error?.message ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {approve.isError ? (
        <ErrorState
          message={getErrorMessage(approve.error)}
          requestId={isApiError(approve.error) ? approve.error.requestId : undefined}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={!ready || approve.isPending}
          onClick={() => approve.mutate()}
        >
          {approve.isPending ? "Saving\u2026" : "Approve and read the file"}
        </Button>
        <Button variant="secondary" disabled={reject.isPending} onClick={() => reject.mutate()}>
          Reject this suggestion
        </Button>
        {missing.length > 0 ? (
          <span className="text-cell text-muted">Still to map: {missing.join(", ")}.</span>
        ) : null}
      </div>

      <VersionHistory sourceId={file.sourceId} fileType={file.fileType} />
    </div>
  );
}

function VersionHistory({
  sourceId,
  fileType,
}: {
  sourceId: string;
  fileType: MappingSuggestion["file"]["fileType"];
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const versions = useQuery({
    queryKey: mappingKeys.versions(sourceId, fileType),
    queryFn: ({ signal }) => listMappingVersions(sourceId, fileType, signal),
  });
  const rollback = useMutation({
    mutationFn: (id: string) => rollbackMapping(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["mapping", "versions"] });
      void queryClient.invalidateQueries({ queryKey: UPLOADS_KEY });
      // Waiting files were released by the rollback, so the review of this file is over.
      if (result.queuedFiles > 0) {
        queryClient.removeQueries({ queryKey: ["mapping", "suggestion"] });
        navigate("/uploads");
      }
    },
  });

  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-3">
      <h2 id="history-heading" className="text-section font-semibold text-ink">
        Saved versions
      </h2>
      {versions.isPending ? (
        <LoadingState label={"Loading versions\u2026"} rows={2} />
      ) : versions.isError ? (
        <ErrorState
          message={getErrorMessage(versions.error)}
          onRetry={() => void versions.refetch()}
        />
      ) : versions.data.length === 0 ? (
        <p className="text-cell text-muted">No mapping has been approved for this source yet.</p>
      ) : (
        <div className="overflow-x-auto border-t border-border-strong">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr>
                <th scope="col" className={th}>
                  Version
                </th>
                <th scope="col" className={th}>
                  Status
                </th>
                <th scope="col" className={th}>
                  Made by
                </th>
                <th scope="col" className={th}>
                  Approved
                </th>
                <th scope="col" className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.data.map((version) => (
                <tr key={version.id}>
                  <td className={cn(td, "tabular-nums")}>
                    v{version.versionNo}
                    {version.rolledBackFromVersionNo !== null ? (
                      <span className="block text-label text-muted">
                        Rolled back to v{version.rolledBackFromVersionNo}
                      </span>
                    ) : null}
                  </td>
                  <td className={td}>
                    <Badge variant={version.status === "ACTIVE" ? "accent" : "neutral"}>
                      {version.status === "ACTIVE" ? "In use" : "Replaced"}
                    </Badge>
                  </td>
                  <td className={td}>{ORIGIN_LABELS[version.origin]}</td>
                  <td className={td}>
                    {version.approvedAt ? formatDateTime(version.approvedAt) : "\u2014"}
                    {version.approvedBy ? (
                      <span className="block text-label text-muted">{version.approvedBy}</span>
                    ) : null}
                  </td>
                  <td className={td}>
                    {version.status === "SUPERSEDED" ? (
                      <Button
                        variant="secondary"
                        disabled={rollback.isPending}
                        onClick={() => rollback.mutate(version.id)}
                      >
                        Roll back to this
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rollback.isError ? (
        <p role="alert" className="text-cell text-risk">
          {getErrorMessage(rollback.error)}
        </p>
      ) : null}
    </section>
  );
}
