import { describe, expect, it } from "vitest";
import { pad2 } from "../../src/format";

describe("format.pad2", () => {
  it("left-pads single digits to two digits", () => {
    expect(pad2(0)).toBe("00");
    expect(pad2(1)).toBe("01");
    expect(pad2(9)).toBe("09");
  });

  it("does not pad multi-digit values", () => {
    expect(pad2(10)).toBe("10");
    expect(pad2(99)).toBe("99");
  });

  it("passes through values wider than two digits unchanged", () => {
    expect(pad2(100)).toBe("100");
  });
});
