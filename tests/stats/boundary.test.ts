import { describe, expect, it } from "vitest";
import { boundary, calibrateC, C_TABLE, simulateFalseWins } from "../../src/stats/boundary.js";

describe("boundary", () => {
  it("AC-CALIB AC-6 boundary false-win rate is about 5%", () => {
    const rate = simulateFalseWins({ K: 15, rule: { kind: "boundary", c: 2.1 }, sims: 20_000, seed: 1 });
    expect(rate).toBeGreaterThan(0.05 - 0.015);
    expect(rate).toBeLessThan(0.05 + 0.015);
  });

  it("AC-CALIB AC-6 naive peeking false-win rate is at least 20%", () => {
    const rate = simulateFalseWins({ K: 15, rule: { kind: "naive" }, sims: 20_000, seed: 1 });
    expect(rate).toBeGreaterThanOrEqual(0.2);
  });

  it("is deterministic for a given seed", () => {
    const o = { K: 15, rule: { kind: "naive" } as const, sims: 2_000, seed: 7 };
    expect(simulateFalseWins(o)).toBe(simulateFalseWins(o));
  });

  it("boundary at week 9", () => {
    expect(Math.abs(boundary(2.1, 15, 9) - 2.711)).toBeLessThan(0.001);
  });

  it("boundary validates inputs", () => {
    expect(() => boundary(2.1, 15, 0)).toThrow();
    expect(() => boundary(2.1, 15, 16)).toThrow();
    expect(() => boundary(2.1, 15, 1.5)).toThrow();
    expect(() => boundary(2.1, 0, 1)).toThrow();
    expect(() => boundary(2.1, 2.5, 1)).toThrow();
    expect(boundary(2.1, 15, 15)).toBeCloseTo(2.1, 12);
  });

  it("calibrateC(15) is within 2.1 ± 0.05", () => {
    expect(Math.abs(calibrateC(15) - 2.1)).toBeLessThan(0.05);
  });

  it("C_TABLE contains 15: 2.1", () => {
    expect(C_TABLE[15]).toBe(2.1);
  });
});
