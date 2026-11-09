import { QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createQueryClient } from "../../lib/query-client";
import { ME_KEY, type AuthUser } from "../auth/auth-api";
import { DashboardPage } from "./DashboardPage";

const executive: AuthUser = {
  id: "u1",
  name: "Exec",
  email: "e@example.test",
  role: "FINANCE_EXECUTIVE",
};
const founder: AuthUser = {
  id: "u2",
  name: "Founder",
  email: "f@example.test",
  role: "CO_FOUNDER",
};

function render(user: AuthUser, url: string): string {
  const queryClient = createQueryClient();
  queryClient.setQueryData(ME_KEY, user);
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const tabsOf = (html: string) =>
  [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((match) => match[1]);

describe("DashboardPage tabs", () => {
  it("has one page title and starts on Money at risk", () => {
    const html = render(executive, "/dashboard");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Money at risk<\/h1>/);
    expect(html).toContain("Loading money at risk");
    expect(html).toContain('aria-label="Dashboard sections"');
  });

  it("gives the finance executive two tabs: no Activity", () => {
    expect(tabsOf(render(executive, "/dashboard"))).toEqual(["Money at risk", "TCS and TDS"]);
  });

  it("gives the co-founder a third tab, Activity", () => {
    expect(tabsOf(render(founder, "/dashboard"))).toEqual([
      "Money at risk",
      "TCS and TDS",
      "Activity",
    ]);
  });

  it("opens the tab named in the address", () => {
    expect(render(executive, "/dashboard?tab=tax")).toContain("Loading TCS and TDS");
    expect(render(founder, "/dashboard?tab=activity")).toContain("Loading activity");
  });

  it("will not open Activity for the finance executive, even by typing the address", () => {
    const html = render(executive, "/dashboard?tab=activity");
    expect(html).toContain("Loading money at risk");
    expect(html).not.toContain("Loading activity");
    expect(html).not.toContain("Activity");
  });

  it("falls back to Money at risk for an unknown tab", () => {
    expect(render(founder, "/dashboard?tab=nonsense")).toContain("Loading money at risk");
  });
});
