import { describe, expect, it } from "vitest";
import { landingPathFor, loginUrlFor, safeNextPath } from "./auth-paths";

describe("landingPathFor", () => {
  it("starts the executive on Uploads and the co-founder on the dashboard", () => {
    expect(landingPathFor("FINANCE_EXECUTIVE")).toBe("/uploads");
    expect(landingPathFor("CO_FOUNDER")).toBe("/dashboard");
  });
});

describe("safeNextPath (where to go after signing in)", () => {
  it("keeps a path inside the app, with its query string", () => {
    expect(safeNextPath("/orders")).toBe("/orders");
    expect(safeNextPath("/orders?status=SETTLED&page=2")).toBe("/orders?status=SETTLED&page=2");
    expect(safeNextPath("/sources/abc/mapping")).toBe("/sources/abc/mapping");
  });

  it("drops anything that could send the person to another website", () => {
    for (const unsafe of [
      "https://evil.example",
      "http://evil.example/x",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "evil.example",
      "orders",
    ]) {
      expect(safeNextPath(unsafe), unsafe).toBeNull();
    }
  });

  it("drops control characters such as line breaks", () => {
    expect(safeNextPath("/orders\r\nSet-Cookie: x=1")).toBeNull();
    expect(safeNextPath("/or\u0000ders")).toBeNull();
  });

  it("drops the sign-in page and the bare root, which would loop or do nothing", () => {
    for (const loop of ["/login", "/login?next=%2Forders", "/login#x", "/"]) {
      expect(safeNextPath(loop), loop).toBeNull();
    }
  });

  it("drops an empty or missing value", () => {
    for (const empty of [null, undefined, ""]) expect(safeNextPath(empty)).toBeNull();
  });
});

describe("loginUrlFor", () => {
  it("remembers the page that was asked for, encoded", () => {
    expect(loginUrlFor("/orders")).toBe("/login?next=%2Forders");
    expect(loginUrlFor("/orders?a=1&b=2")).toBe("/login?next=%2Forders%3Fa%3D1%26b%3D2");
  });

  it("is plain /login when there is nothing safe to remember", () => {
    expect(loginUrlFor("/")).toBe("/login");
    expect(loginUrlFor("/login")).toBe("/login");
    expect(loginUrlFor("//evil.example")).toBe("/login");
  });
});
