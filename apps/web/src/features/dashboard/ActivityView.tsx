import { EmptyState } from "../../components/feedback";
import { Badge, Button, cn } from "../../components/ui";
import type { AuditEntry } from "./dashboard-api";
import { describeAuditMeta, entityLabel, formatWhen } from "./dashboard-model";
import { stickyFirst, td, th } from "./table-styles";

export interface ActivityViewProps {
  items: readonly AuditEntry[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export function ActivityView({ items, hasMore, loadingMore, onLoadMore }: ActivityViewProps) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        description="Sign-ins, uploads, mapping approvals and rate card changes appear here as they happen."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-muted">
        Who did what, newest first. Only the co-founder can see this list, and nothing in it can be
        changed or deleted from the app. It holds no customer data.
      </p>
      <div className="max-h-[36rem] overflow-auto border-t border-border-strong">
        <table className="w-full min-w-[720px] border-collapse">
          <caption className="sr-only">Recent activity</caption>
          <thead>
            <tr className="text-left">
              <th scope="col" className={cn(th, "sticky top-0 z-10", stickyFirst)}>
                When
              </th>
              <th scope="col" className={cn(th, "sticky top-0")}>
                Who
              </th>
              <th scope="col" className={cn(th, "sticky top-0")}>
                What
              </th>
              <th scope="col" className={cn(th, "sticky top-0")}>
                Details
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => {
              const details = describeAuditMeta(entry.meta);
              return (
                <tr key={entry.id} className="group">
                  <td className={cn(td, stickyFirst)}>{formatWhen(entry.createdAt)}</td>
                  <td className={td}>
                    {entry.user ? (
                      entry.user.name
                    ) : (
                      <span className="text-muted">Not signed in</span>
                    )}
                  </td>
                  <td className={td}>
                    <span className="inline-flex items-center gap-2">
                      {entry.label}
                      {entry.action === "LOGIN_FAILED" ? (
                        <Badge variant="risk">Refused</Badge>
                      ) : null}
                    </span>
                  </td>
                  <td className={cn(td, "text-muted")}>
                    {details || entityLabel(entry.entityType)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMore ? (
        <div>
          <Button onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading\u2026" : "Show older activity"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
