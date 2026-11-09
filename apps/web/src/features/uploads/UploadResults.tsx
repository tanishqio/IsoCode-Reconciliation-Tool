import { Badge } from "../../components/ui";
import type { UploadOutcome } from "./uploads-api";
import { formatDateTime } from "./uploads-model";

/** What happened to each file in the last upload, in plain words. */
export function UploadResults({ outcome }: { outcome: UploadOutcome }) {
  const { accepted, duplicate, rejected } = outcome.summary;
  const parts = [
    `${accepted} saved`,
    `${duplicate} duplicate${duplicate === 1 ? "" : "s"}`,
    `${rejected} not uploaded`,
  ];

  return (
    <section
      aria-labelledby="upload-result-heading"
      className="rounded-ui border border-border p-4"
    >
      <h3 id="upload-result-heading" className="text-body font-semibold text-ink">
        Upload result
      </h3>
      <p className="mt-0.5 text-cell text-muted">{parts.join(" \u00b7 ")}</p>

      <ul className="mt-3 flex flex-col gap-3">
        {outcome.results.map((result) => (
          <li key={result.index} className="flex flex-wrap items-start gap-x-3 gap-y-1">
            {result.status === "ACCEPTED" ? (
              <Badge variant="accent">Saved</Badge>
            ) : result.status === "DUPLICATE" ? (
              <Badge>Duplicate</Badge>
            ) : (
              <Badge>Not uploaded</Badge>
            )}
            <div className="min-w-0 flex-1 text-cell">
              <span className="block break-all font-medium text-ink">{result.fileName}</span>
              <span className="block text-muted">
                {result.status === "ACCEPTED"
                  ? `${
                      result.file.detectedRowCount === null
                        ? "Rows not counted"
                        : `${result.file.detectedRowCount} rows found`
                    }. ${
                      result.file.status === "QUEUED"
                        ? "Its column names are already mapped, so it is being read now."
                        : "Its column names are new, so review a mapping next."
                    }`
                  : result.status === "DUPLICATE"
                    ? `Same content as ${result.existing.originalName}, uploaded on ${formatDateTime(result.existing.uploadedAt)}. Removed, not processed.`
                    : result.message}
              </span>
              {result.status === "ACCEPTED" && result.file.warning ? (
                <span className="block text-muted">{result.file.warning}</span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
