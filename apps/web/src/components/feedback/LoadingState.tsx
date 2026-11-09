import { cn } from "../ui/cn";

export interface LoadingStateProps {
  /** Text shown to everyone and read out by screen readers. Default "Loading…". */
  label?: string;
  /** Number of grey placeholder rows. Default 5. */
  rows?: number;
  className?: string;
}

const ROW_WIDTHS = ["w-full", "w-11/12", "w-full", "w-10/12", "w-9/12"];

/** A calm, static placeholder. No shimmer, no spinner. */
export function LoadingState({ label = "Loading\u2026", rows = 5, className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("rounded-ui border border-border bg-page p-4", className)}
    >
      <p className="text-body text-muted">{label}</p>
      <div aria-hidden="true" className="mt-3 flex flex-col gap-2">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className={cn("h-5 rounded-ui bg-hover", ROW_WIDTHS[index % 5])} />
        ))}
      </div>
    </div>
  );
}
