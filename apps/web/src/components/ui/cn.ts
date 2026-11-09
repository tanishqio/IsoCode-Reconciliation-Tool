import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge has to know our token names. Without this it cannot tell the font size
// `text-label` from the colour `text-muted` and would drop one of them.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["label", "cell", "body", "section", "title"],
      color: [
        "page",
        "sidebar",
        "surface",
        "hover",
        "border",
        "border-strong",
        "ink",
        "ink-2",
        "muted",
        "faint",
        "accent",
        "accent-hover",
        "accent-tint",
        "on-accent",
        "risk",
        "risk-tint",
        "scrim",
      ],
      radius: ["ui"],
      shadow: ["overlay"],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts (the last one wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
