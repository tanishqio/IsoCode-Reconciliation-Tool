import { describe, expect, it } from "vitest";
import { formatRupees, groupIndian, isNegativeAmount } from "./format-rupees";

describe("formatRupees", () => {
  it("shows rupees with two decimals and the rupee sign", () => {
    expect(formatRupees("0")).toBe("₹0.00");
    expect(formatRupees("0.5")).toBe("₹0.50");
    expect(formatRupees("1499")).toBe("₹1,499.00");
    expect(formatRupees(1499)).toBe("₹1,499.00");
    expect(formatRupees(862.4)).toBe("₹862.40");
  });

  it("groups digits the Indian way (lakh and crore)", () => {
    expect(formatRupees("123456")).toBe("₹1,23,456.00");
    expect(formatRupees("10000000")).toBe("₹1,00,00,000.00");
    expect(formatRupees("900719925474099.93")).toBe("₹90,07,19,92,54,74,099.93");
    expect(groupIndian("100000")).toBe("1,00,000");
  });

  it("shows a negative amount with a true minus sign, not a hyphen", () => {
    expect(formatRupees("-37")).toBe("\u2212₹37.00");
    expect(formatRupees(-1409)).not.toContain("-");
    expect(formatRupees("-0.00")).toBe("₹0.00");
    expect(formatRupees("-37", { symbol: false })).toBe("\u221237.00");
  });

  it("formats the sample orders from the assignment", () => {
    expect(["1409", "0", "-1409"].map((v) => formatRupees(v))).toEqual([
      "₹1,409.00",
      "₹0.00",
      "\u2212₹1,409.00",
    ]);
  });

  it("refuses a wrong amount instead of showing it", () => {
    for (const bad of ["1.234", "abc", "", NaN, Infinity, 1.005]) {
      expect(() => formatRupees(bad)).toThrow(RangeError);
    }
  });

  it("tells whether an amount is below zero", () => {
    expect(isNegativeAmount("-0.01")).toBe(true);
    expect(isNegativeAmount("-0.00")).toBe(false);
    expect(isNegativeAmount("5")).toBe(false);
  });
});
