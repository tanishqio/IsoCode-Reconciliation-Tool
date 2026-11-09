// TEMPORARY. Preview of AppShell with a fake user, a role switch and sample content.
// Entry for apps/web/shell-preview.html. Delete this folder after AppShell is integrated.
// Query options for quick checks: ?role=co-founder and ?path=/dashboard
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../components/feedback";
import { AppShell, getPageTitle, type ShellRole } from "../components/layout";
import { Badge, Button, Money, PageHeader, cn } from "../components/ui";
import "../styles/index.css";

interface SampleOrder {
  id: string;
  source: string;
  sellingPrice: number; // integer paise
  payment: string;
  status: string;
  expected: number;
  received: number;
}

const ORDERS: SampleOrder[] = [
  {
    id: "ORD-W-204118",
    source: "Website",
    sellingPrice: 149900,
    payment: "COD",
    status: "Delivered",
    expected: 140900,
    received: 0,
  },
  {
    id: "ORD-M-88120",
    source: "Marketplace 1",
    sellingPrice: 119900,
    payment: "Prepaid",
    status: "Delivered",
    expected: 89900,
    received: 86200,
  },
  {
    id: "ORD-W-204377",
    source: "Website",
    sellingPrice: 239800,
    payment: "Prepaid",
    status: "Returned to warehouse",
    expected: -9600,
    received: -14200,
  },
];

const th =
  "h-9 whitespace-nowrap border-b border-border-strong bg-page px-3 text-label font-medium uppercase tracking-wider text-muted";
const td = "h-10 whitespace-nowrap border-b border-border px-3 text-cell group-hover:bg-surface";
const stickyFirst =
  "max-sm:sticky max-sm:left-0 max-sm:border-r max-sm:border-r-border max-sm:bg-page";

function OrdersTable() {
  const netDifference = ORDERS.reduce((sum, order) => sum + (order.received - order.expected), 0);
  return (
    <section aria-labelledby="orders-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="orders-heading" className="text-section font-semibold text-ink">
          Orders
        </h2>
        <p className="text-cell text-muted">
          {ORDERS.length} orders &middot; Net difference{" "}
          <Money paise={netDifference} tone="difference" />
        </p>
      </div>
      <div className="max-h-96 overflow-auto border-t border-border-strong">
        <table className="w-full min-w-[880px] border-collapse">
          <thead>
            <tr className="text-left">
              <th scope="col" className={cn(th, "sticky top-0 z-10", stickyFirst)}>
                Order ID
              </th>
              <th scope="col" className={cn(th, "sticky top-0")}>
                Source
              </th>
              <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                Selling price
              </th>
              <th scope="col" className={cn(th, "sticky top-0")}>
                Payment
              </th>
              <th scope="col" className={cn(th, "sticky top-0")}>
                Status
              </th>
              <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                Expected
              </th>
              <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                Received
              </th>
              <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                Difference
              </th>
            </tr>
          </thead>
          <tbody>
            {ORDERS.map((order) => (
              <tr key={order.id} className="group">
                <td className={cn(td, stickyFirst)}>
                  <a href="#order" className="font-medium text-accent hover:underline">
                    {order.id}
                  </a>
                </td>
                <td className={td}>{order.source}</td>
                <td className={cn(td, "text-right")}>
                  <Money paise={order.sellingPrice} />
                </td>
                <td className={td}>{order.payment}</td>
                <td className={td}>
                  <Badge>{order.status}</Badge>
                </td>
                <td className={cn(td, "text-right")}>
                  <Money paise={order.expected} />
                </td>
                <td className={cn(td, "text-right")}>
                  <Money paise={order.received} />
                </td>
                <td className={cn(td, "text-right")}>
                  <Money paise={order.received - order.expected} tone="difference" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SamplePage(props: {
  role: ShellRole;
  onRoleChange: (role: ShellRole) => void;
  lastAction: string;
}) {
  const { pathname } = useLocation();
  const title = getPageTitle(pathname);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={title}
        description="Every order with the amount we expected and the amount we received."
        actions={<Button variant="primary">Primary action</Button>}
      />

      <fieldset className="rounded-ui border border-border p-3">
        <legend className="px-1 text-label font-medium uppercase tracking-wider text-muted">
          Preview controls (temporary)
        </legend>
        <div className="flex flex-wrap items-center gap-4 text-body">
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              name="role"
              checked={props.role === "FINANCE_EXECUTIVE"}
              onChange={() => props.onRoleChange("FINANCE_EXECUTIVE")}
              className="accent-accent"
            />
            Finance executive
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              name="role"
              checked={props.role === "CO_FOUNDER"}
              onChange={() => props.onRoleChange("CO_FOUNDER")}
              className="accent-accent"
            />
            Co-founder
          </label>
          <span className="text-cell text-muted" aria-live="polite">
            {props.lastAction}
          </span>
        </div>
      </fieldset>

      <OrdersTable />

      <section aria-labelledby="buttons-heading">
        <h2 id="buttons-heading" className="mb-3 text-section font-semibold text-ink">
          Buttons and badges
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <Badge>Neutral</Badge>
          <Badge variant="accent">Accent</Badge>
          <Badge variant="risk">Risk</Badge>
        </div>
      </section>

      <section aria-labelledby="states-heading" className="flex flex-col gap-4">
        <h2 id="states-heading" className="text-section font-semibold text-ink">
          Loading, empty and error states
        </h2>
        <LoadingState />
        <EmptyState
          title="No orders yet"
          description="Upload an orders file to see orders and their differences here."
          action={<Button variant="primary">Go to Uploads</Button>}
        />
        <ErrorState
          message="We could not load the orders. Please try again."
          requestId="req_7f3a91c2d0e84b56"
          onRetry={() => undefined}
        />
      </section>
    </div>
  );
}

function Preview() {
  const params = new URLSearchParams(window.location.search);
  const [role, setRole] = useState<ShellRole>(
    params.get("role") === "co-founder" ? "CO_FOUNDER" : "FINANCE_EXECUTIVE",
  );
  const [lastAction, setLastAction] = useState("");
  const startPath = params.get("path") ?? "/orders";

  return (
    <MemoryRouter initialEntries={[startPath]}>
      <Routes>
        <Route
          element={
            <AppShell
              user={{
                name: role === "CO_FOUNDER" ? "Rohan Mehta" : "Meera Iyer",
                role,
              }}
              onLogout={() => setLastAction("Logout was clicked.")}
              navCounts={{ "/review": 12 }}
            />
          }
        >
          <Route
            path="*"
            element={<SamplePage role={role} onRoleChange={setRole} lastAction={lastAction} />}
          />
        </Route>
        <Route path="/" element={<Navigate to="/orders" replace />} />
      </Routes>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
