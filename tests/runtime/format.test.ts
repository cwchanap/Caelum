import { describe, expect, it } from "vitest";
import { formatMinutes, pad2 } from "../../src/format";

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

describe("format.formatMinutes", () => {
  it("renders seconds as one-decimal minutes", () => {
    expect(formatMinutes(192)).toBe("3.2 min");
    expect(formatMinutes(0)).toBe("0.0 min");
  });

  it("renders an em dash when there is no current wait", () => {
    expect(formatMinutes(null)).toBe("—");
  });
});
