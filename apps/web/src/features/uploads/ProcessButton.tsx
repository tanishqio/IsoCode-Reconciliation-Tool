import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/ui";
import { getErrorMessage } from "../../lib/api-error";
import { processFile, UPLOADS_KEY, type UploadedFile } from "./uploads-api";

/** Queues a failed file to be read again. The list then refreshes until the file is done. */
export function ProcessButton({ file }: { file: UploadedFile }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => processFile(file.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: UPLOADS_KEY }),
  });

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="secondary" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        {mutation.isPending
          ? "Queuing\u2026"
          : file.status === "FAILED"
            ? "Try again"
            : "Process file"}
      </Button>
      {mutation.isError ? (
        <span role="alert" className="max-w-72 whitespace-normal text-label text-risk">
          {getErrorMessage(mutation.error)}
        </span>
      ) : null}
    </div>
  );
}
