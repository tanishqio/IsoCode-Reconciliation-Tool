import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAV_ITEMS } from "../components/layout";
import { ME_KEY, type AuthUser } from "../features/auth/auth-api";
import { createQueryClient } from "../lib/query-client";
import { ROUTE_DEFS } from "./route-config";
import { createRoutes } from "./routes";

const executive: AuthUser = {
  id: "u1",
  name: "Test Executive",
  email: "e@example.test",
  role: "FINANCE_EXECUTIVE",
};
const founder: AuthUser = {
  id: "u2",
  name: "Test Founder",
  email: "f@example.test",
  role: "CO_FOUNDER",
};

afterEach(() => vi.unstubAllGlobals());

type Who = AuthUser | "signed-out" | "server-down";

/** Renders the route tree on the server (no browser) as the given kind of visitor. */
async function visit(url: string, who: Who) {
  const queryClient: QueryClient = createQueryClient();
  if (who === "signed-out") {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Please sign in." } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
    );
  } else if (who === "server-down") {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
  } else {
    queryClient.setQueryData(ME_KEY, who); // as if "who am I" had already been answered
  }

  const handler = createStaticHandler(createRoutes(queryClient));
  const context = await handler.query(new Request(`http://localhost${url}`));
  if (context instanceof Response) {
    return { status: context.status, location: context.headers.get("Location"), html: "" };
  }
  const router = createStaticRouter(handler.dataRoutes, context);
  const html = renderToString(
    <QueryClientProvider client={queryClient}>
      <StaticRouterProvider router={router} context={context} />
    </QueryClientProvider>,
  );
  return { status: context.statusCode, location: null, html };
}

const h1 = (text: string) => new RegExp(`<h1[^>]*>${text}</h1>`);
const insideShell = (html: string) =>
  html.includes("Skip to content") && html.includes('id="main-content"');

describe("signed in as the finance executive", () => {
  it("sends / to Uploads", async () => {
    const result = await visit("/", executive);
    expect(result.status).toBe(302);
    expect(result.location).toBe("/uploads");
  });

  it("renders every page from the website map inside the app shell", async () => {
    for (const route of ROUTE_DEFS) {
      const { status, html } = await visit(`/${route.path.replace(":sourceId", "abc")}`, executive);
      expect(status, route.path).toBe(200);
      expect(html, route.path).toMatch(h1(route.title));
      expect(insideShell(html), route.path).toBe(true);
    }
  });

  it("shows the signed-in name and role in the shell", async () => {
    const { html } = await visit("/orders", executive);
    expect(html).toContain("Test Executive");
    expect(html).toContain("Finance executive");
  });

  it("shows the not-found page for an unknown URL, inside the shell", async () => {
    const { html } = await visit("/no/such/page", executive);
    expect(html).toMatch(h1("Page not found"));
    expect(insideShell(html)).toBe(true);
  });

  it("sends the sign-in page on to the right place: their start page, or a safe ?next=", async () => {
    expect((await visit("/login", executive)).location).toBe("/uploads");
    expect((await visit("/login?next=%2Forders", executive)).location).toBe("/orders");
    for (const unsafe of ["https%3A%2F%2Fevil.example", "%2F%2Fevil.example", "%2Flogin"]) {
      expect((await visit(`/login?next=${unsafe}`, executive)).location, unsafe).toBe("/uploads");
    }
  });
});

describe("signed in as the co-founder", () => {
  it("sends / to the dashboard", async () => {
    expect((await visit("/", founder)).location).toBe("/dashboard");
  });

  it("can open the pages the website map gives them", async () => {
    for (const path of ["orders", "rate-cards", "claims", "dashboard"]) {
      const { status, html } = await visit(`/${path}`, founder);
      expect(status, path).toBe(200);
      expect(insideShell(html), path).toBe(true);
    }
  });

  it("gets a No access page (403), inside the shell, on executive-only pages", async () => {
    for (const path of ["uploads", "review", "sources/abc/mapping"]) {
      const { status, html } = await visit(`/${path}`, founder);
      expect(status, path).toBe(403);
      expect(html, path).toMatch(h1("No access"));
      expect(html, path).toContain("Your role cannot open this page");
      expect(insideShell(html), path).toBe(true);
    }
  });

  it("is not shown the Uploads or Review links in the sidebar", async () => {
    const { html } = await visit("/orders", founder);
    expect(html).not.toContain('href="/uploads"');
    expect(html).not.toContain('href="/review"');
    expect(html).toContain('href="/claims"');
  });
});

describe("signed out", () => {
  it("sends every app page to sign-in, remembering where the person was going", async () => {
    expect((await visit("/orders", "signed-out")).location).toBe("/login?next=%2Forders");
    expect((await visit("/uploads?x=1", "signed-out")).location).toBe(
      "/login?next=%2Fuploads%3Fx%3D1",
    );
    expect((await visit("/no/such/page", "signed-out")).location).toBe(
      "/login?next=%2Fno%2Fsuch%2Fpage",
    );
  });

  it("sends / to plain sign-in", async () => {
    expect((await visit("/", "signed-out")).location).toBe("/login");
  });

  it("shows the sign-in form, without the app shell", async () => {
    const { status, html } = await visit("/login", "signed-out");
    expect(status).toBe(200);
    expect(html).toMatch(h1("Sign in"));
    expect(html).toContain("Email");
    expect(html).toContain("Password");
    expect(html).toContain('type="password"');
    expect(html).toContain("current-password");
    expect(insideShell(html)).toBe(false);
  });
});

describe("when the server cannot be reached", () => {
  it("shows an error page for an app page, not a sign-in redirect and not a blank screen", async () => {
    const { status, html } = await visit("/orders", "server-down");
    expect(status).toBe(500);
    expect(html).toMatch(h1("Something went wrong"));
    expect(html).toContain("Could not reach the server");
  });

  it("still shows the sign-in form, so signing in can report the real problem", async () => {
    const { status, html } = await visit("/login", "server-down");
    expect(status).toBe(200);
    expect(html).toMatch(h1("Sign in"));
  });
});

describe("sidebar and routes", () => {
  it("agree on the pages, their titles and who may open them", () => {
    for (const item of NAV_ITEMS) {
      const route = ROUTE_DEFS.find((candidate) => `/${candidate.path}` === item.to);
      expect(route, `no route for sidebar link ${item.to}`).toBeDefined();
      expect(route?.title, item.to).toBe(item.label);
      expect([...(route?.roles ?? [])].sort(), item.to).toEqual([...item.roles].sort());
    }
  });
});
