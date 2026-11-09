import { cn } from "../../components/ui";

/** A pill that filters a list. Pressed means the filter is on. */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-8 rounded-ui border px-3 text-cell",
        active
          ? "border-transparent bg-accent-tint font-medium text-accent"
          : "border-border-strong bg-page text-ink-2 hover:bg-hover",
      )}
    >
      {children}
    </button>
  );
}
