import { LogOut, Menu } from "lucide-react";
import type { Ref } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ROLE_LABELS, type ShellUser } from "./types";

export interface TopBarProps {
  user: ShellUser;
  /** Name of the current page. Shown only below 1024px, where the page header is not next to the menu. */
  title: string;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onLogout: () => void;
  /** Lets the shell return focus to the menu button when the menu closes. */
  menuButtonRef: Ref<HTMLButtonElement>;
}

/** 56px sticky bar. Desktop: user, role and Logout on the right. Phone: menu button, title, Logout icon. */
export function TopBar({
  user,
  title,
  menuOpen,
  onOpenMenu,
  onLogout,
  menuButtonRef,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-(--size-topbar) items-center gap-3 border-b border-border bg-page px-4 lg:px-6">
      <Button
        ref={menuButtonRef}
        variant="secondary"
        size="icon"
        className="lg:hidden"
        aria-label="Open menu"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={onOpenMenu}
      >
        <Menu aria-hidden="true" className="size-4" strokeWidth={1.75} />
      </Button>
      <span className="min-w-0 truncate text-body font-semibold text-ink lg:hidden">{title}</span>

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-cell font-medium text-ink sm:inline">{user.name}</span>
        <Badge className="hidden sm:inline-flex">{ROLE_LABELS[user.role]}</Badge>
        <Button variant="ghost" className="max-sm:w-8 max-sm:px-0" onClick={onLogout}>
          <LogOut aria-hidden="true" className="size-4" strokeWidth={1.75} />
          <span className="sr-only sm:not-sr-only">Logout</span>
        </Button>
      </div>
    </header>
  );
}
