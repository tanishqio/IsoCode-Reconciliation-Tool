import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "icon";

export interface ButtonProps extends ComponentProps<"button"> {
  /** primary: one per screen at most. secondary: default. ghost: low-emphasis actions such as Logout. */
  variant?: ButtonVariant;
  /** md: 32px high. icon: 32px square, needs an aria-label. */
  size?: ButtonSize;
  /** Render the child element (for example a router Link) with the button styles. */
  asChild?: boolean;
}

const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-ui border " +
  "text-cell font-medium disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "border-border-strong bg-page text-ink hover:bg-hover",
  ghost: "border-transparent bg-transparent text-ink-2 hover:bg-hover",
};

const sizes: Record<ButtonSize, string> = {
  md: "h-8 px-3",
  icon: "size-8 p-0",
};

export function Button({
  variant = "secondary",
  size = "md",
  asChild = false,
  type,
  className,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      // A button inside a form must not submit it by accident.
      type={asChild ? undefined : (type ?? "button")}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  );
}
