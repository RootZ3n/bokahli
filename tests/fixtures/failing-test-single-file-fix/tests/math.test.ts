import { describe, expect, it } from "vitest";
import { clamp } from "../src/math.js";

describe("clamp", () => {
  it("returns min for values below min", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it("returns max for values above max", () => {
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it("returns value when it is in range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
