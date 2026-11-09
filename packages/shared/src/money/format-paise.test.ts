import { describe, expect, it } from "vitest";
import { formatPaise, groupIndian } from "./format-paise";

describe("formatPaise", () => {
  it("shows rupees and paise with the rupee sign", () => {
    expect(formatPaise(0)).toBe("₹0.00");
    expect(formatPaise(5)).toBe("₹0.05");
    expect(formatPaise(99)).toBe("₹0.99");
    expect(formatPaise(100)).toBe("₹1.00");
    expect(formatPaise(149900)).toBe("₹1,499.00");
  });

  it("groups digits the Indian way (lakh and crore)", () => {
    expect(formatPaise(12345600)).toBe("₹1,23,456.00");
    expect(formatPaise(123456700)).toBe("₹12,34,567.00");
    expect(formatPaise(1000000000)).toBe("₹1,00,00,000.00");
    expect(groupIndian("100000")).toBe("1,00,000");
  });

  it("shows a negative amount with a true minus sign, not a hyphen", () => {
    expect(formatPaise(-3700)).toBe("\u2212₹37.00");
    expect(formatPaise(-3700)).not.toContain("-");
  });

  it("formats the three sample orders from the assignment correctly", () => {
    // Expected, received and difference, in paise, for ORD-W-204118, ORD-M-88120 and ORD-W-204377.
    expect([140900, 0, -140900].map((value) => formatPaise(value))).toEqual([
      "₹1,409.00",
      "₹0.00",
      "\u2212₹1,409.00",
    ]);
    expect([89900, 86200, -3700].map((value) => formatPaise(value))).toEqual([
      "₹899.00",
      "₹862.00",
      "\u2212₹37.00",
    ]);
    expect([-9600, -14200, -4600].map((value) => formatPaise(value))).toEqual([
      "\u2212₹96.00",
      "\u2212₹142.00",
      "\u2212₹46.00",
    ]);
  });

  it("can leave out the rupee sign", () => {
    expect(formatPaise(149900, { symbol: false })).toBe("1,499.00");
    expect(formatPaise(-3700, { symbol: false })).toBe("\u221237.00");
  });

  it("is exact for amounts too large for a normal number", () => {
    expect(formatPaise(9007199254740993n)).toBe("₹9,00,71,99,25,47,409.93");
  });

  it("refuses a fractional or unsafe number instead of showing a wrong amount", () => {
    for (const bad of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => formatPaise(bad)).toThrow(RangeError);
    }
  });
});
