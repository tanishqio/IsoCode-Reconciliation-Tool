import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../../components/ui";
import type { FileResult } from "./uploads-api";
import { formatDateTime } from "./uploads-model";

type Duplicate = Extract<FileResult, { status: "DUPLICATE" }>;

/**
 * The pop-up shown when an uploaded file is an exact copy of one already uploaded for the same
 * source and file type. The copy was removed and will not be processed.
 */
export function DuplicateDialog({
  duplicates,
  open,
  onOpenChange,
}: {
  duplicates: readonly Duplicate[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const many = duplicates.length > 1;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-ui border border-border bg-page p-5 shadow-overlay">
          <Dialog.Title className="text-section font-semibold text-ink">
            {many ? "These files are duplicates" : "This file is a duplicate"}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-body text-ink-2">
            {many
              ? "They were removed and will not be processed."
              : "It was removed and will not be processed."}
          </Dialog.Description>

          <ul className="mt-4 flex max-h-56 flex-col gap-3 overflow-y-auto">
            {duplicates.map((duplicate) => (
              <li key={duplicate.index} className="text-cell">
                <span className="block break-all font-medium text-ink">{duplicate.fileName}</span>
                <span className="block text-muted">
                  Same content as {duplicate.existing.originalName}, uploaded on{" "}
                  {formatDateTime(duplicate.existing.uploadedAt)}.
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex justify-end">
            <Dialog.Close asChild>
              <Button variant="primary">OK</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
