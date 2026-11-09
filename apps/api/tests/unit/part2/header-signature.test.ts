import { describe, expect, it } from "vitest";
import { buildHeaderSignature, normaliseHeader } from "../../../src/lib/header-signature.js";

describe("normaliseHeader", () => {
  it.each([
    ["  Order ID ", "order id"],
    ["ORDER   ID", "order id"],
    ["\uFEFFOrder ID", "order id"],
    ["Order\tID", "order id"],
    ["Ｏrder ＩＤ", "order id"],
    ["Amount ₹", "amount ₹"],
    ["", ""],
  ])("%j becomes %j", (input, expected) => {
    expect(normaliseHeader(input)).toBe(expected);
  });
});

describe("buildHeaderSignature", () => {
  it("returns a 64 character hex string", () => {
    expect(buildHeaderSignature(["a", "b"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the same whatever the column order is", () => {
    expect(buildHeaderSignature(["Order ID", "Amount", "Date"])).toBe(
      buildHeaderSignature(["Date", "Order ID", "Amount"]),
    );
  });

  it("ignores case, extra spaces and a byte order mark", () => {
    expect(buildHeaderSignature(["Order ID", "Amount"])).toBe(
      buildHeaderSignature(["\uFEFF  order   id ", "AMOUNT"]),
    );
  });

  it("ignores empty header cells (trailing empty columns in a spreadsheet)", () => {
    expect(buildHeaderSignature(["a", "b"])).toBe(buildHeaderSignature(["a", "b", "", "  "]));
  });

  it("changes when a column is renamed", () => {
    expect(buildHeaderSignature(["Order ID", "Amount"])).not.toBe(
      buildHeaderSignature(["Order ID", "Net Amount"]),
    );
  });

  it("changes when a column is added or removed", () => {
    const base = buildHeaderSignature(["a", "b"]);
    expect(buildHeaderSignature(["a", "b", "c"])).not.toBe(base);
    expect(buildHeaderSignature(["a"])).not.toBe(base);
  });

  it("treats a repeated column name as a different layout", () => {
    expect(buildHeaderSignature(["a", "a", "b"])).not.toBe(buildHeaderSignature(["a", "b"]));
  });

  it("cannot be confused by names that contain the join character", () => {
    expect(buildHeaderSignature(["a|b", "c"])).not.toBe(buildHeaderSignature(["a", "b|c"]));
    expect(buildHeaderSignature(['a","b'])).not.toBe(buildHeaderSignature(["a", "b"]));
  });

  it("gives a stable value for an empty header list", () => {
    expect(buildHeaderSignature([])).toBe(buildHeaderSignature(["", " "]));
  });
});
