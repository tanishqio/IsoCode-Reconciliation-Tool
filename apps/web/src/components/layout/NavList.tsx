import { NavLink } from "react-router-dom";
import { cn } from "../ui/cn";
import { NAV_GROUPS, navItemsForRole } from "./nav-items";
import type { NavCounts, ShellRole } from "./types";

export interface NavListProps {
  role: ShellRole;
  counts?: NavCounts;
  /** Called when a link is chosen (the mobile menu closes itself with this). */
  onNavigate?: () => void;
  /** Prefix for element ids, so the sidebar and the mobile menu do not share ids. */
  idPrefix: string;
}

/** The navigation links, grouped. Used by the desktop sidebar and the mobile menu. */
export function NavList({ role, counts, onNavigate, idPrefix }: NavListProps) {
  const items = navItemsForRole(role);

  return (
    <nav aria-label="Main">
      {NAV_GROUPS.map((group) => {
        const groupItems = items.filter((item) => item.group === group.id);
        if (groupItems.length === 0) return null;
        const labelId = `${idPrefix}-${group.id}`;
        return (
          <div key={group.id} className="mb-1">
            <p
              id={labelId}
              className="px-2 pb-1 pt-3 text-label font-medium uppercase tracking-wider text-muted"
            >
              {group.label}
            </p>
            <ul aria-labelledby={labelId} className="flex flex-col gap-0.5">
              {groupItems.map((item) => {
                const count = counts?.[item.to];
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          "relative flex h-10 items-center gap-2 rounded-ui px-2 text-body lg:h-8",
                          isActive
                            ? "bg-accent-tint font-medium text-accent before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
                            : "text-ink-2 hover:bg-hover",
                        )
                      }
                    >
                      <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
                      {item.label}
                      {count !== undefined && count > 0 ? (
                        <span className="ml-auto rounded-ui border border-border bg-page px-1.5 text-label font-normal text-ink-2">
                          {count > 999 ? "999+" : count}
                          <span className="sr-only"> waiting</span>
                        </span>
                      ) : null}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
