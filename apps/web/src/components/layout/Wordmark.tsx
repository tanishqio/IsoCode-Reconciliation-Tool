import { Link } from "react-router-dom";
import { cn } from "../ui/cn";

/** "LeakLens" as plain text with a small accent square. No image. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      className={cn(
        "inline-flex items-center gap-2 rounded-ui px-2 text-section font-semibold tracking-tight text-ink",
        className,
      )}
    >
      <span aria-hidden="true" className="size-2.5 bg-accent" />
      LeakLens
    </Link>
  );
}
