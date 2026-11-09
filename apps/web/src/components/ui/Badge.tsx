import type { ComponentProps } from "react";
import { cn } from "./cn";

export type BadgeVariant = "neutral" | "accent" | "risk";

export interface BadgeProps extends ComponentProps<"span"> {
  /** neutral: statuses and roles. accent: selected or new. risk: only for differences and money at risk. */
  variant?: BadgeVariant;
}

const variants: Record<BadgeVariant, string> = {
  neutral: "border-border bg-hover text-ink-2",
  accent: "border-transparent bg-accent-tint text-accent",
  risk: "border-transparent bg-risk-tint text-risk",
};

export function Badge({ variant = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-ui border px-2 text-label",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
