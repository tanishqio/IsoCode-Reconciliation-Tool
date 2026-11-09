import * as Dialog from "@radix-ui/react-dialog";
import { LogOut, X } from "lucide-react";
import type { RefObject } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { NavList } from "./NavList";
import { ROLE_LABELS, type NavCounts, type ShellUser } from "./types";
import { Wordmark } from "./Wordmark";

export interface MobileMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: ShellUser;
  counts?: NavCounts;
  onLogout: () => void;
  /** The button that opens the menu. Focus goes back to it on close (Safari does not focus buttons on click). */
  returnFocusRef: RefObject<HTMLElement | null>;
}

/**
 * Left drawer for screens under 1024px. Radix Dialog gives it the dialog role, focus trapping,
 * Esc to close, closing on overlay click, and returning focus to the menu button.
 * It also closes when the route changes (AppShell) and when a link is chosen.
 */
export function MobileMenu({
  open,
  onOpenChange,
  user,
  counts,
  onLogout,
  returnFocusRef,
}: MobileMenuProps) {
  const close = () => onOpenChange(false);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim lg:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-border bg-sidebar px-2 py-3 shadow-overlay lg:hidden"
        >
          <Dialog.Title className="sr-only">Main menu</Dialog.Title>
          <div className="flex items-center justify-between pb-2">
            <Wordmark />
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close menu">
                <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
              </Button>
            </Dialog.Close>
          </div>

          <NavList role={user.role} counts={counts} onNavigate={close} idPrefix="drawer" />

          <div className="mt-auto flex flex-col items-start gap-2 border-t border-border px-2 pt-3">
            <span className="text-cell font-medium text-ink">{user.name}</span>
            <Badge>{ROLE_LABELS[user.role]}</Badge>
            <Button
              variant="ghost"
              className="-ml-3"
              onClick={() => {
                close();
                onLogout();
              }}
            >
              <LogOut aria-hidden="true" className="size-4" strokeWidth={1.75} />
              Logout
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
