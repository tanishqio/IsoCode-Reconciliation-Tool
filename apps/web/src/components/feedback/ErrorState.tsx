import { CircleAlert } from "lucide-react";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

export interface ErrorStateProps {
  message: string;
  /** The API returns one with every error. Shown small so it can be copied for support. */
  requestId?: string;
  /** When given, a "Try again" button is shown. */
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ message, requestId, onRetry, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-ui border border-risk/30 bg-risk-tint p-4",
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-risk" />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-ink">{message}</p>
        {requestId ? (
          <p className="mt-1 text-label text-muted">
            Request ID <span className="select-all break-all">{requestId}</span>
          </p>
        ) : null}
        {onRetry ? (
          <Button variant="secondary" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
