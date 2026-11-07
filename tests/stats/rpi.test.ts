import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATA_DIR, loadDataset } from "../../src/data/csv.js";
import type { Dataset, Txn, User } from "../../src/data/csv.js";
import { normalCdf, userRevenue, welch } from "../../src/stats/rpi.js";

const DAY = 86_400_000;
const T0 = new Date("2026-01-01T00:00:00Z");
const at = (days: number): Date => new Date(T0.getTime() + days * DAY);
const user = (userId: string, installDay: number): User => ({
  userId, installAt: at(installDay), flow: "f", abTest: "t", aiEditsFirstDay: 0,
});
const txn = (userId: string, day: number, priceUsd: number, refundDay: number | null = null): Txn => ({
  userId, purchasedAt: at(day), priceUsd, refundedAt: refundDay === null ? null : at(refundDay),
});

describe("normalCdf", () => {
  it("matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(-1.96)).toBeCloseTo(0.0249979, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normalCdf(8)).toBeCloseTo(1, 9);
  });
});

describe("welch", () => {
  it("[0,0,1,1] vs [1,1,2,2] gives diff 1 and z > 0", () => {
    const r = welch([0, 0, 1, 1], [1, 1, 2, 2]);
    expect(r.diff).toBeCloseTo(1, 12);
    expect(r.z).toBeGreaterThan(0);
    expect(r.nA).toBe(4);
    expect(r.nB).toBe(4);
    expect(r.p).toBeGreaterThan(0);
    expect(r.p).toBeLessThan(1);
  });
  it("never returns NaN for n<2 or zero variance", () => {
    for (const [a, b] of [[[], []], [[1], [2]], [[1, 1], [1, 1]], [[1, 1], [2, 2]]] as const) {
      const r = welch([...a], [...b]);
      expect(Number.isNaN(r.z) || Number.isNaN(r.p) || Number.isNaN(r.se)).toBe(false);
    }
    expect(welch([1, 1], [1, 1])).toMatchObject({ z: 0, p: 1 });
  });
});

describe("userRevenue", () => {
  it("includes zeros, applies horizon, cutoff and refunds", () => {
    const users = [user("a", 0), user("b", 0), user("c", 10), user("d", 25)];
    const txns = [
      txn("a", 5, 10),          // in horizon
      txn("a", 40, 100),        // outside 30d horizon of install
      txn("b", 1, 20, 3),       // refunded in horizon -> 0
      txn("c", 12, 7, 45),      // refund after horizon of install (day 40) -> not subtracted
      txn("d", 26, 5),          // d installed too late for 30d horizon at cutoff day 50
    ];
    const m = userRevenue(users, txns, { cutoff: at(50), horizonDays: 30 });
    expect([...m.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(m.get("a")).toBe(10);
    expect(m.get("b")).toBe(0);
    expect(m.get("c")).toBe(7);
  });
  it("null horizon = revenue to date at cutoff; later installs and events ignored", () => {
    const users = [user("a", 0), user("b", 60)];
    const txns = [txn("a", 5, 10), txn("a", 40, 100, 55), txn("a", 52, 3), txn("b", 61, 9)];
    const m = userRevenue(users, txns, { cutoff: at(50), horizonDays: null });
    expect([...m.keys()]).toEqual(["a"]);
    expect(m.get("a")).toBe(110); // 10 + 100; refund on day 55 and purchase on day 52 are after cutoff
    const m2 = userRevenue(users, txns, { cutoff: at(56), horizonDays: null });
    expect(m2.get("a")).toBe(10 + 100 - 100 + 3);
  });
  it("install exactly horizonDays before cutoff is included", () => {
    const m = userRevenue([user("a", 0)], [txn("a", 30, 4)], { cutoff: at(30), horizonDays: 30 });
    expect(m.get("a")).toBe(4);
  });
});

const ONB = "Onboarding: annual trial vs weekly first";
const SET = "Settings: upgrade vs lifetime anchor";
const real = existsSync(DEFAULT_DATA_DIR);

function arm(ds: Dataset, abTest: string, flow: string, cutoff: Date, horizonDays: number | null): number[] {
  const us = ds.users.filter((u) => u.abTest === abTest && u.flow === flow);
  const rev = userRevenue(us, ds.txns, { cutoff, horizonDays });
  return [...rev.values()];
}

describe.skipIf(!real)("real data", () => {
  it("Onboarding D60 RPI", async () => {
    const ds = await loadDataset();
    const a = arm(ds, ONB, "onb_trial", ds.dataEnd, 60);
    const b = arm(ds, ONB, "onb_weekly", ds.dataEnd, 60);
    const r = welch(a, b);
    expect(r.meanA).toBeCloseTo(4.52, 1);
    expect(r.meanB).toBeCloseTo(8.57, 1);
    expect(Math.abs(r.diff - 4.05)).toBeLessThanOrEqual(0.05);
  });
  it("Settings end state", async () => {
    const ds = await loadDataset();
    const a = arm(ds, SET, "main_lifetime", ds.dataEnd, null);
    const b = arm(ds, SET, "settings", ds.dataEnd, null);
    const r = welch(a, b);
    expect(Math.abs(r.diff - -1.57)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(r.p - 0.067)).toBeLessThanOrEqual(0.003);
  });
});
