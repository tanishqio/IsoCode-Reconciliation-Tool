import { useId, type ComponentProps } from "react";
import { cn } from "./cn";
import { fieldControlClass } from "./TextField";

export interface SelectFieldProps extends ComponentProps<"select"> {
  label: string;
  /** Keep the label for screen readers but do not show it (for a select inside a table row). */
  hideLabel?: boolean;
  /** Text of the first, empty option, for example "Choose a source". */
  placeholder?: string;
  options: readonly { value: string; label: string }[];
}

/** A native select (works well on phones and with a keyboard), styled like the text field. */
export function SelectField({
  label,
  hideLabel = false,
  placeholder,
  options,
  id,
  className,
  ...props
}: SelectFieldProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label
        htmlFor={selectId}
        className={cn("text-cell font-medium text-ink", hideLabel && "sr-only")}
      >
        {label}
      </label>
      <select id={selectId} className={cn(fieldControlClass, "border-border-strong")} {...props}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
