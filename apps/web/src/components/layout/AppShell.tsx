import { useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { MobileMenu } from "./MobileMenu";
import { getPageTitle } from "./nav-items";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import type { NavCounts, ShellUser } from "./types";
import { useMediaQuery } from "./use-media-query";

export interface AppShellProps {
  user: ShellUser;
  onLogout: () => void;
  /** Optional count badges by nav path, for example { "/review": 12 }. */
  navCounts?: NavCounts;
}

/**
 * Layout route component: sidebar, top bar and, in the content area, the child route (<Outlet />).
 * It fetches nothing. The router passes the user and the logout handler.
 */
export function AppShell({ user, onLogout, navCounts }: AppShellProps) {
  const { pathname } = useLocation();
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  // The menu is "open for" the path it was opened on, so any route change closes it
  // without an effect. On a desktop-wide screen it is never open.
  const [openForPath, setOpenForPath] = useState<string | null>(null);
  const menuOpen = !isDesktop && openForPath === pathname;
  const setMenuOpen = (open: boolean) => setOpenForPath(open ? pathname : null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="min-h-dvh bg-page">
      <a
        href="#main-content"
        className="sr-only rounded-ui border border-border-strong bg-page px-3 py-2 text-cell font-medium text-accent focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to content
      </a>

      <Sidebar role={user.role} counts={navCounts} />
      <MobileMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        user={user}
        counts={navCounts}
        onLogout={onLogout}
        returnFocusRef={menuButtonRef}
      />

      <div className="flex min-h-dvh min-w-0 flex-col lg:pl-(--size-sidebar)">
        <TopBar
          user={user}
          title={getPageTitle(pathname)}
          menuOpen={menuOpen}
          onOpenMenu={() => setMenuOpen(true)}
          onLogout={onLogout}
          menuButtonRef={menuButtonRef}
        />
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full min-w-0 max-w-(--size-content-max) flex-1 p-4 outline-none lg:p-6"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
