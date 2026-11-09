import { describe, expect, it } from "vitest";
import { ageText, recoveredProblem, statusVariant } from "./claims-model";

describe("claims screen rules", () => {
  it("accepts a recovered amount only if it is a real amount within the claim", () => {
    expect(recoveredProblem("900", "936.00")).toBeNull();
    expect(recoveredProblem("936.00", "936.00")).toBeNull();
    expect(recoveredProblem("936.01", "936.00")).toContain("cannot be more");
    expect(recoveredProblem("0", "936.00")).toContain("more than zero");
    expect(recoveredProblem("12.345", "936.00")).toContain("Enter the amount");
    expect(recoveredProblem("abc", "936.00")).toContain("Enter the amount");
  });

  it("writes ages and highlights only open claims", () => {
    expect(ageText(null)).toBe("\u2014");
    expect(ageText(1)).toBe("1 day");
    expect(ageText(45)).toBe("45 days");
    expect(statusVariant("OPEN")).toBe("accent");
    expect(statusVariant("EXPORTED")).toBe("neutral");
  });
});
