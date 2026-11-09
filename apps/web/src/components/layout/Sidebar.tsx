import { NavList } from "./NavList";
import type { NavCounts, ShellRole } from "./types";
import { Wordmark } from "./Wordmark";

export interface SidebarProps {
  role: ShellRole;
  counts?: NavCounts;
}

/** Fixed 240px sidebar for screens of 1024px and wider. Below that, MobileMenu is used. */
export function Sidebar({ role, counts }: SidebarProps) {
  return (
    <div className="fixed inset-y-0 left-0 z-20 hidden w-(--size-sidebar) flex-col overflow-y-auto border-r border-border bg-sidebar px-2 py-4 lg:flex">
      <div className="pb-4">
        <Wordmark />
      </div>
      <NavList role={role} counts={counts} idPrefix="sidebar" />
    </div>
  );
}
