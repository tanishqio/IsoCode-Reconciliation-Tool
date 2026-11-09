import { describe, expect, it } from "vitest";
import { describeLineIds, partnerLine, strength } from "./review-model";

describe("review queue wording", () => {
  it("describes how sure a suggestion is in words, not numbers", () => {
    expect(strength(100).label).toBe("Strong match");
    expect(strength(85).label).toBe("Strong match");
    expect(strength(70).label).toBe("Likely match");
    expect(strength(55).label).toBe("Possible match");
  });

  it("says what the line itself carries, so it can be compared with a suggestion", () => {
    expect(describeLineIds(null, null)).toBe("No order ID on the line, no AWB");
    expect(describeLineIds("ORD-M-9OO10", "AWB1")).toBe(
      "Order ID on the line: ORD-M-9OO10, AWB: AWB1",
    );
    expect(partnerLine("COD_REMITTANCE", "Aggregator 1")).toBe("COD remittance from Aggregator 1");
    expect(partnerLine("RETURN_SCAN", "Warehouse")).toBe("Warehouse return scan");
  });
});
