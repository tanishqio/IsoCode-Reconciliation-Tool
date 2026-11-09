import type { ReactNode } from "react";
import { cn } from "../ui/cn";

export interface EmptyStateProps {
  title: string;
  /** One line that says what to do next. */
  description: string;
  /** Optional call to action, for example a <Button>. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-ui border border-border bg-page px-6 py-10 text-center",
        className,
      )}
    >
      <h2 className="text-body font-semibold text-ink">{title}</h2>
      <p className="mt-1 max-w-md text-body text-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
