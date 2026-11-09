import { describe, expect, it } from "vitest";
import { formatDate, pageCount, showsLoss, statusVariant } from "./orders-model";

describe("orders screen rules", () => {
  it("uses red only for the statuses that mean lost money", () => {
    for (const status of [
      "SHORT_PAID",
      "UNPAID_PAST_DUE",
      "FREIGHT_OVERCHARGED",
      "RETURN_NOT_RECEIVED",
    ] as const) {
      expect(statusVariant(status)).toBe("risk");
    }
    for (const status of [
      "SETTLED",
      "PENDING",
      "OVERPAID",
      "NOT_TRACKED",
      "CANNOT_CALCULATE",
    ] as const) {
      expect(statusVariant(status)).toBe("neutral");
    }
  });

  it("does not show a loss for orders that are not due, not tracked or not calculated", () => {
    expect(showsLoss("SHORT_PAID")).toBe(true);
    expect(showsLoss("SETTLED")).toBe(true);
    expect(showsLoss("PENDING")).toBe(false);
    expect(showsLoss("NOT_TRACKED")).toBe(false);
    expect(showsLoss("CANNOT_CALCULATE")).toBe(false);
  });

  it("counts pages, with at least one", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(99_440, 50)).toBe(1989);
  });

  it("shows dates as the day in the file, whatever the computer's time zone", () => {
    expect(formatDate("2026-11-03T00:00:00.000Z")).toContain("3");
    expect(formatDate("2026-11-03T00:00:00.000Z")).toContain("2026");
  });
});
