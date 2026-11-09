import type { ReactNode } from "react";
import { cn } from "./cn";

export interface PageHeaderProps {
  title: string;
  /** One line under the title. */
  description?: string;
  /** Buttons for the right side. */
  actions?: ReactNode;
  className?: string;
}

/** The single h1 of a page. The top bar shows the page name only on small screens. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        "mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-title font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-0.5 text-body text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
