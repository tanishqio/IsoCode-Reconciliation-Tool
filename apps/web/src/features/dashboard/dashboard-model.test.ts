import { describe, expect, it } from "vitest";
import {
  describeAuditMeta,
  entityLabel,
  formatCount,
  formatDataDate,
  fromPaise,
  isPositive,
  monthLabel,
  parseTab,
  percentOf,
  pluralise,
  sumAmounts,
  toPaise,
} from "./dashboard-model";

describe("tabs", () => {
  it("opens the tab named in the address", () => {
    expect(parseTab("tax", false)).toBe("tax");
    expect(parseTab("tax", true)).toBe("tax");
    expect(parseTab("risk", true)).toBe("risk");
  });

  it("falls back to Money at risk for nothing or an unknown name", () => {
    expect(parseTab(null, true)).toBe("risk");
    expect(parseTab("", true)).toBe("risk");
    expect(parseTab("admin", true)).toBe("risk");
  });

  it("opens Activity for the co-founder only", () => {
    expect(parseTab("activity", true)).toBe("activity");
    expect(parseTab("activity", false)).toBe("risk");
  });
});

describe("money arithmetic on text amounts", () => {
  it.each([
    ["0", 0n],
    ["1", 100n],
    ["1.5", 150n],
    ["1234.56", 123456n],
    ["-12.30", -1230n],
    ["0.07", 7n],
    ["99999999999.99", 9999999999999n],
  ])("reads %s as %s paise", (text, paise) => {
    expect(toPaise(text)).toBe(paise);
  });

  it.each(["", "abc", "1.234", "1,000.00", "--1", "1e3", "₹5"])("refuses %j", (text) => {
    expect(() => toPaise(text)).toThrow(RangeError);
  });

  it("writes paise back as text with two decimals", () => {
    expect(fromPaise(0n)).toBe("0.00");
    expect(fromPaise(7n)).toBe("0.07");
    expect(fromPaise(150n)).toBe("1.50");
    expect(fromPaise(-1230n)).toBe("-12.30");
    expect(fromPaise(123456789n)).toBe("1234567.89");
  });

  it("adds exactly, with no floating point drift", () => {
    expect(sumAmounts(["0.1", "0.2"])).toBe("0.30");
    expect(sumAmounts(Array.from({ length: 10 }, () => "0.10"))).toBe("1.00");
    expect(sumAmounts(["1409.00", "46.00", "37.00", "100.50"])).toBe("1592.50");
    expect(sumAmounts([])).toBe("0.00");
    expect(sumAmounts(["5.00", "-5.00"])).toBe("0.00");
  });

  it("tells whether an amount is above zero", () => {
    expect(isPositive("0.01")).toBe(true);
    expect(isPositive("0.00")).toBe(false);
    expect(isPositive("-1.00")).toBe(false);
  });

  it("works out a rounded percentage, or nothing when the whole is zero", () => {
    expect(percentOf("50.00", "200.00")).toBe(25);
    expect(percentOf("1.00", "3.00")).toBe(33);
    expect(percentOf("2.00", "3.00")).toBe(67);
    expect(percentOf("0.00", "10.00")).toBe(0);
    expect(percentOf("10.00", "10.00")).toBe(100);
    expect(percentOf("5.00", "0.00")).toBeNull();
  });
});

describe("wording", () => {
  it("groups counts the Indian way", () => {
    expect(formatCount(1234567)).toBe("12,34,567");
    expect(formatCount(0)).toBe("0");
  });

  it("uses the singular for one", () => {
    expect(pluralise(1, "order")).toBe("1 order");
    expect(pluralise(2, "order")).toBe("2 orders");
    expect(pluralise(0, "order")).toBe("0 orders");
    expect(pluralise(1200, "file")).toBe("1,200 files");
  });

  it("shows the date of the data in UTC, as stored", () => {
    expect(formatDataDate("2026-11-30T00:00:00.000Z")).toBe("30 Nov 2026");
    expect(formatDataDate("2026-11-30T23:59:59.000Z")).toBe("30 Nov 2026");
  });

  it("names a month", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("not-a-month")).toBe("not-a-month");
  });

  it("names the thing an activity entry was about", () => {
    expect(entityLabel("RATE_CARD")).toBe("Rate card");
    expect(entityLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("describeAuditMeta", () => {
  it("shows only friendly facts and never ids", () => {
    const text = describeAuditMeta({
      batchId: "11111111-2222-4333-8444-555555555555",
      sourceId: "99999999-2222-4333-8444-555555555555",
      fileId: "abc",
      fileType: "SETTLEMENT",
      sizeBytes: 2048,
      versionNo: 3,
      queuedFiles: 2,
    });
    expect(text).toBe("Settlement \u00B7 2.0 KB \u00B7 version 3 \u00B7 2 files queued");
    expect(text).not.toMatch(/1111|9999|abc/);
  });

  it("is empty when there is nothing friendly to say", () => {
    expect(describeAuditMeta({})).toBe("");
    expect(describeAuditMeta({ batchId: "x", previousId: "y" })).toBe("");
  });

  it("handles sizes, a repeated request and no queued files", () => {
    expect(describeAuditMeta({ sizeBytes: 500 })).toBe("500 B");
    expect(describeAuditMeta({ sizeBytes: 3 * 1024 * 1024 })).toBe("3.0 MB");
    expect(describeAuditMeta({ queuedFiles: 0 })).toBe("");
    expect(describeAuditMeta({ queuedFiles: 1 })).toBe("1 file queued");
    expect(describeAuditMeta({ alreadyQueued: true })).toBe("a calculation was already waiting");
    expect(describeAuditMeta({ alreadyQueued: false })).toBe("");
  });

  it("keeps an unknown file type as it is", () => {
    expect(describeAuditMeta({ fileType: "REFUNDS" })).toBe("REFUNDS");
  });
});
