import { useId, type ComponentProps } from "react";
import { cn } from "./cn";

export interface TextFieldProps extends ComponentProps<"input"> {
  label: string;
  /** Shown under the field, and the field is marked invalid for screen readers. */
  error?: string;
}

export const fieldControlClass =
  "h-9 w-full rounded-ui border bg-page px-3 text-body text-ink placeholder:text-muted " +
  "disabled:bg-surface disabled:text-muted";

/** A labelled text input. The label is always visible and tied to the input. */
export function TextField({ label, error, id, className, ...props }: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={inputId} className="text-cell font-medium text-ink">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(fieldControlClass, error ? "border-risk" : "border-border-strong")}
        {...props}
      />
      {error ? (
        <p id={errorId} className="text-label text-risk">
          {error}
        </p>
      ) : null}
    </div>
  );
}
