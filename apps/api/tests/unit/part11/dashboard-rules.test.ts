import { describe, expect, it } from "vitest";
import {
  AGE_BUCKET_LIMITS,
  AGE_BUCKETS,
  ageInDays,
  bucketIndexForDays,
} from "../../../src/modules/dashboard/age-buckets.js";
import {
  monthStart,
  taxSummaryQuerySchema,
} from "../../../src/modules/dashboard/dashboard.schemas.js";
import {
  isRiskStatus,
  partnerIdFor,
  RISK_STATUSES,
} from "../../../src/modules/dashboard/partner-attribution.js";

describe("age bands", () => {
  it("has four bands that start where the last one ended", () => {
    expect(AGE_BUCKETS).toHaveLength(4);
    expect(AGE_BUCKETS[0]?.fromDays).toBe(0);
    for (let index = 1; index < AGE_BUCKETS.length; index += 1) {
      const previous = AGE_BUCKETS[index - 1];
      expect(AGE_BUCKETS[index]?.fromDays).toBe((previous?.toDays ?? NaN) + 1);
    }
    expect(AGE_BUCKETS[AGE_BUCKETS.length - 1]?.toDays).toBeNull();
    expect(AGE_BUCKET_LIMITS).toEqual([30, 60, 90]);
  });

  it.each([
    [0, 0],
    [1, 0],
    [30, 0],
    [31, 1],
    [60, 1],
    [61, 2],
    [90, 2],
    [91, 3],
    [365, 3],
    [10_000, 3],
  ])("puts %i days in band %i", (days, band) => {
    expect(bucketIndexForDays(days)).toBe(band);
  });

  it("treats negative and fractional days as whole days that are never negative", () => {
    expect(bucketIndexForDays(-5)).toBe(0);
    expect(bucketIndexForDays(30.9)).toBe(0);
    expect(bucketIndexForDays(31.1)).toBe(1);
  });

  it("agrees with the band labels", () => {
    for (const [index, band] of AGE_BUCKETS.entries()) {
      expect(bucketIndexForDays(band.fromDays)).toBe(index);
      if (band.toDays !== null) expect(bucketIndexForDays(band.toDays)).toBe(index);
    }
  });
});

describe("ageInDays", () => {
  const day = (text: string) => new Date(`${text}T00:00:00Z`);

  it("counts calendar days from the anchor to the as-of date", () => {
    expect(ageInDays(day("2026-11-30"), day("2026-11-01"))).toBe(29);
    expect(ageInDays(day("2026-11-01"), day("2026-11-01"))).toBe(0);
  });

  it("ignores the time of day", () => {
    expect(ageInDays(new Date("2026-11-02T00:10:00Z"), new Date("2026-11-01T23:50:00Z"))).toBe(1);
    expect(ageInDays(new Date("2026-11-01T23:59:59Z"), new Date("2026-11-01T00:00:00Z"))).toBe(0);
  });

  it("is never negative when the anchor is after the as-of date", () => {
    expect(ageInDays(day("2026-11-01"), day("2026-11-20"))).toBe(0);
  });
});

describe("which partner owes the money", () => {
  const channelId = "channel";
  const courierId = "courier";

  it("sends a prepaid short payment or unpaid settlement to the sales channel", () => {
    for (const status of ["SHORT_PAID", "UNPAID_PAST_DUE"] as const) {
      expect(partnerIdFor({ status, paymentType: "PREPAID", channelId, courierId })).toBe(
        channelId,
      );
    }
  });

  it("sends cash on delivery to the courier", () => {
    for (const status of ["SHORT_PAID", "UNPAID_PAST_DUE"] as const) {
      expect(partnerIdFor({ status, paymentType: "COD", channelId, courierId })).toBe(courierId);
    }
  });

  it("sends freight charges and lost returns to the courier, whatever the payment type", () => {
    for (const status of ["FREIGHT_OVERCHARGED", "RETURN_NOT_RECEIVED"] as const) {
      for (const paymentType of ["COD", "PREPAID"] as const) {
        expect(partnerIdFor({ status, paymentType, channelId, courierId })).toBe(courierId);
      }
    }
  });

  it("falls back to the sales channel when the order has no courier", () => {
    for (const status of RISK_STATUSES) {
      for (const paymentType of ["COD", "PREPAID"] as const) {
        expect(partnerIdFor({ status, paymentType, channelId, courierId: null })).toBe(channelId);
      }
    }
  });
});

describe("risk statuses", () => {
  it("are exactly the four findings that lose money", () => {
    expect([...RISK_STATUSES].sort()).toEqual([
      "FREIGHT_OVERCHARGED",
      "RETURN_NOT_RECEIVED",
      "SHORT_PAID",
      "UNPAID_PAST_DUE",
    ]);
  });

  it("do not include statuses that are not losses", () => {
    for (const status of [
      "SETTLED",
      "OVERPAID",
      "PENDING",
      "NOT_TRACKED",
      "CANNOT_CALCULATE",
      "",
    ]) {
      expect(isRiskStatus(status)).toBe(false);
    }
    expect(isRiskStatus("SHORT_PAID")).toBe(true);
  });
});

describe("month filter", () => {
  it.each([
    ["2026-08", "2026-08-01"],
    ["2026-12", "2026-12-01"],
    ["1999-01", "1999-01-01"],
  ])("turns %s into %s", (month, start) => {
    expect(monthStart(month)).toBe(start);
  });

  it.each([
    "2026-13",
    "2026-00",
    "2026-1",
    "26-08",
    "2026/08",
    "2026-08-01",
    "",
    " 2026-08",
    "abcd-ef",
  ])("rejects %j", (month) => {
    expect(monthStart(month)).toBeNull();
    expect(() => taxSummaryQuerySchema.parse({ month })).toThrow();
  });

  it("accepts no month at all", () => {
    expect(taxSummaryQuerySchema.parse({})).toEqual({});
  });
});
