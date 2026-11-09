import { describe, expect, it } from "vitest";
import type { MappingField } from "./mapping-api";
import {
  canApprove,
  describeSource,
  duplicateColumns,
  missingRequired,
  needsCheck,
  setField,
} from "./mapping-model";

const fields: MappingField[] = [
  { name: "orderId", label: "Order ID", kind: "id", required: true },
  { name: "value", label: "Order value", kind: "money", required: true },
  { name: "awb", label: "AWB", kind: "id", required: false },
];

describe("editing a mapping", () => {
  it("sets and clears a field without changing the original", () => {
    const start = { orderId: "Ref" };
    expect(setField(start, "value", "Amount")).toEqual({ orderId: "Ref", value: "Amount" });
    expect(setField(start, "orderId", "")).toEqual({});
    expect(start).toEqual({ orderId: "Ref" });
  });

  it("allows approval only when every required field has its own column and nothing is wrong", () => {
    expect(missingRequired(fields, { orderId: "Ref" })).toEqual(["Order value"]);
    expect(duplicateColumns({ orderId: "Ref", value: "Ref" })).toEqual(["Ref"]);
    expect(canApprove(fields, { orderId: "Ref", value: "Amount" }, [])).toBe(true);
    expect(canApprove(fields, { orderId: "Ref" }, [])).toBe(false);
    expect(canApprove(fields, { orderId: "Ref", value: "Ref" }, [])).toBe(false);
    expect(canApprove(fields, { orderId: "Ref", value: "Amount" }, ["bad column"])).toBe(false);
  });

  it("tells the person which suggestions to check", () => {
    expect(needsCheck({ source: "ai", confidence: "low" })).toBe(true);
    expect(needsCheck({ source: "rule", confidence: "high" })).toBe(false);
    expect(describeSource({ source: "ai", confidence: "medium" }, false)).toBe("AI: fairly sure");
    expect(describeSource({ source: "ai", confidence: "medium" }, true)).toBe("Chosen by you");
  });
});
