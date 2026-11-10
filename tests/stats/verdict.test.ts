import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATA_DIR, loadDataset } from "../../src/data/csv.js";
import type { Dataset } from "../../src/data/csv.js";
import { boundary } from "../../src/stats/boundary.js";
import { extraRevenueFromShipping } from "../../src/stats/money.js";
import { goalMetricOf, loadPlans, UnknownTestError } from "../../src/stats/plans.js";
import type { TestPlan } from "../../src/stats/plans.js";
import { judgeTest, testTimeline } from "../../src/stats/verdict.js";

const DAY = 86_400_000;
const real = existsSync(DEFAULT_DATA_DIR);

const plans = loadPlans();
const find = (prefix: string): TestPlan => {
  const p = plans.find((x) => x.title.startsWith(prefix));
  if (!p) throw new Error(`no plan ${prefix}`);
  return p;
};
const onb = find("Onboarding");
const settings = find("Settings");

function lookDate(ds: Dataset, plan: TestPlan, k: number): Date {
  const first = Math.min(...ds.users.filter((u) => u.abTest === plan.title && plan.arms.includes(u.flow)).map((u) => u.installAt.getTime()));
  return new Date(Math.floor(first / DAY) * DAY + k * 7 * DAY);
}

describe("test plans", () => {
  it("derives goal metric names from the horizon", () => {
    expect(goalMetricOf(onb)).toBe("rpi_60d");
    expect(goalMetricOf(settings)).toBe("rpi_30d");
    expect(goalMetricOf({ ...settings, horizonDays: null })).toBe("rpi");
  });
  it("loads the checked-in plans in arm order", () => {
    expect(onb).toMatchObject({ arms: ["onb_trial", "onb_weekly"], horizonDays: 60, K: 15 });
    expect(settings).toMatchObject({ arms: ["main_lifetime", "settings"], horizonDays: 30 });
    expect(settings.K).toBeUndefined();
  });
  it("rejects a malformed plan file", () => {
    const f = join(mkdtempSync(join(tmpdir(), "plans-")), "p.json");
    writeFileSync(f, JSON.stringify([{ title: "x", arms: ["a"], goal: "rpi", horizonDays: 30 }]));
    expect(() => loadPlans(f)).toThrow(/two arm names/);
  });
});

describe.skipIf(!real)("verdicts on real data", () => {
  it("unknown plan title", async () => {
    const d = await loadDataset();
    const f = join(mkdtempSync(join(tmpdir(), "plans-")), "p.json");
    writeFileSync(f, JSON.stringify([{ title: "Ghost: no such test", arms: ["a", "b"], goal: "rpi", horizonDays: 30 }]));
    expect(() => loadPlans(f, d)).toThrow(/Ghost: no such test/);
    expect(() => loadPlans(f, d)).toThrow(UnknownTestError);
    const ghost = loadPlans(f)[0] as TestPlan;
    expect(() => judgeTest(ghost, d, {})).toThrow(/Ghost: no such test/);
    expect(() => testTimeline(ghost, d, {})).toThrow(/Ghost: no such test/);
  });

  it("AC-2 Onboarding stop at week 2 is blocked as BEFORE_HORIZON", async () => {
    const d = await loadDataset();
    const v = judgeTest(onb, d, { asOf: lookDate(d, onb, 2) });
    expect(v.verdict).toBe("CONTINUE");
    expect(v.code).toBe("BEFORE_HORIZON");
    expect(v.lookK).toBe(2);
    expect(v.reasons.join(" ")).toMatch(/look 9/);
  });

  it("AC-2 Onboarding is WINNER at week 9 on 60-day revenue", async () => {
    const d = await loadDataset();
    const v = judgeTest(onb, d, { asOf: lookDate(d, onb, 9) });
    expect(v.verdict).toBe("WINNER");
    expect(v.winnerArm).toBe("onb_weekly");
    expect(v.goalMetric).toBe("rpi_60d");
    expect(v.goalSource).toBe("test_plan");
    expect(v.lookK).toBe(9);
    expect(Math.abs(Math.abs(v.z ?? 0) - 4.34)).toBeLessThanOrEqual(0.1);
    expect(Math.abs((v.boundary ?? 0) - 2.71)).toBeLessThanOrEqual(0.02);
    const t = testTimeline(onb, d, {});
    expect(t.firstCrossing?.k).toBe(9);
    expect(t.firstCrossing?.arm).toBe("onb_weekly");
  });

  it("AC-PEEK Settings as_of 2026-08-16 is blocked by the boundary despite naive p < 0.05", async () => {
    const d = await loadDataset();
    const asOf = lookDate(d, settings, 6);
    expect(asOf.toISOString().slice(0, 10)).toBe("2026-08-16");
    const v = judgeTest(settings, d, { asOf });
    expect(v.lookK).toBe(6);
    expect(v.pNaive).not.toBeNull();
    expect(v.pNaive as number).toBeLessThan(0.05);
    expect(Math.abs(v.z as number)).toBeLessThan(v.boundary as number);
    expect(v.verdict).toBe("CONTINUE");
    expect(v.code).toBeUndefined();
    expect(v.boundary as number).toBeCloseTo(3.32, 2);
    expect(v.KSource).toBe("fallback");
    // a date-only as_of (midnight UTC) from an agent lands on the same look
    const dateOnly = judgeTest(settings, d, { asOf: new Date("2026-08-16") });
    expect(dateOnly.lookK).toBe(6);
    expect(dateOnly.pNaive as number).toBeLessThan(0.05);
  });

  it("look boundaries: one ms before look k is look k-1; dataEnd is capped at K", async () => {
    const d = await loadDataset();
    expect(judgeTest(settings, d, { asOf: new Date(lookDate(d, settings, 6).getTime() - 1) }).lookK).toBe(5);
    expect(judgeTest(settings, d, { asOf: d.dataEnd }).lookK).toBe(15);
    const v = judgeTest(settings, d, { asOf: d.dataEnd });
    expect(v.reasons.join(" ")).toMatch(/\d+ installs fall after look 15/);
  });

  it("AC-SHOP payer-rate stop for Settings is refused as metric shopping", async () => {
    const d = await loadDataset();
    for (const metric of ["payer_rate", "rpi"] as const) {
      const v = judgeTest(settings, d, { metric });
      expect(v.verdict).toBe("CONTINUE");
      expect(v.code).toBe("METRIC_NOT_GOAL");
      expect(v.winnerArm).toBeNull();
      expect(v.reasons.join(" ")).toContain("metric shopping");
      expect(v.reasons.join(" ")).toContain("rpi_30d");
    }
    // the declared goal itself is accepted
    expect(judgeTest(settings, d, { metric: "rpi_30d" }).code).toBeUndefined();
  });

  it("AC-1 Settings boundary never crossed for the declared winner", async () => {
    const d = await loadDataset();
    const t = testTimeline(settings, d, {});
    expect(t.looks.length).toBeGreaterThan(5);
    expect(t.looks.some((l) => l.crossed && l.leader === "settings")).toBe(false);
  });

  it("AC-1 Settings declared winner is not supported at the end", async () => {
    const d = await loadDataset();
    const t = testTimeline(settings, d, {});
    expect(t.end.leader).toBe("main_lifetime");
    expect(t.end.date).toBe(d.dataEnd.toISOString().slice(0, 10));
    expect(t.end.arms.map((a) => a.arm)).toEqual(["main_lifetime", "settings"]);
    expect(t.end.arms.every((a) => a.n > 1000)).toBe(true);
    expect(Math.abs(t.end.effect - -0.68)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(t.end.pNaive - 0.5)).toBeLessThanOrEqual(0.01);
    const v = judgeTest(settings, d, {});
    expect(v.verdict).not.toBe("WINNER");
    expect(v.leader).toBe("main_lifetime");
    expect(Math.abs((v.pNaive as number) - 0.41)).toBeLessThanOrEqual(0.01);
    // revenue to date is not the goal; shown for explanation only
    const toDate = testTimeline(settings, d, { metric: "rpi" });
    expect(toDate.end.leader).toBe("main_lifetime");
    expect(Math.abs(toDate.end.pNaive - 0.067)).toBeLessThanOrEqual(0.003);
  });

  it("AC-8 every number has a source label", async () => {
    const d = await loadDataset();
    expect(judgeTest(onb, d, { asOf: lookDate(d, onb, 9) }).source).toBe("export_csv");
    expect(judgeTest(settings, d, { metric: "payer_rate" }).source).toBe("export_csv");
    expect(testTimeline(onb, d, {}).source).toBe("export_csv");
  });

  it("AC-9 fallback K is visible", async () => {
    const d = await loadDataset();
    const v = judgeTest(settings, d, {});
    expect(v.KSource).toBe("fallback");
    expect(v.K).toBe(15);
    expect(v.reasons.join(" ")).toContain("the built-in fallback K = 15");
    expect(judgeTest(onb, d, {}).KSource).toBe("test_plan");
    expect(testTimeline(settings, d, {}).KSource).toBe("fallback");
  });

  it("AC-9 the policy's fallbackK is used when the plan gives no K", async () => {
    const d = await loadDataset();
    const v = judgeTest(settings, d, { fallbackK: 10 });
    expect(v.KSource).toBe("fallback");
    expect(v.K).toBe(10);
    expect(v.reasons.join(" ")).toContain("the policy's fallbackK = 10");
    expect(testTimeline(settings, d, { fallbackK: 10 }).K).toBe(10);
    // A K in the plan wins over the policy's fallback.
    expect(judgeTest(onb, d, { fallbackK: 10 }).K).toBe(onb.K);
  });

  it("AC-9 K from the plan changes the boundary", async () => {
    const d = await loadDataset();
    const asOf = lookDate(d, onb, 9);
    const a = judgeTest({ ...onb, K: 15 }, d, { asOf });
    const b = judgeTest({ ...onb, K: 20 }, d, { asOf });
    expect(a.K).toBe(15);
    expect(b.K).toBe(20);
    expect(a.boundary).not.toBeNull();
    expect(b.boundary).not.toBe(a.boundary);
    expect(b.boundary as number).toBeGreaterThan(a.boundary as number);
    expect(a.boundary).toBeCloseTo(boundary(2.1, 15, 9), 10);
  });

  it("INVALID_AS_OF", async () => {
    const d = await loadDataset();
    for (const s of ["2026-06-01", "2026-12-01"]) {
      const v = judgeTest(settings, d, { asOf: new Date(`${s}T00:00:00Z`) });
      expect(v.code).toBe("INVALID_AS_OF");
      expect(v.verdict).toBe("CONTINUE");
      expect(v.reasons.join(" ")).toMatch(/valid range/);
      expect(v.reasons.join(" ")).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it("a non-goal timeline shows its looks but never reports a crossing", async () => {
    const d = await loadDataset();
    const t = testTimeline(settings, d, { metric: "payer_rate" });
    expect(t.goalMetric).toBe("rpi_30d");
    expect(t.metric).toBe("payer_rate");
    expect(t.firstCrossing).toBeNull();
    expect(t.looks.length).toBeGreaterThan(0);
    expect(t.looks.some((l) => l.crossed)).toBe(false);
  });

  it("AC-11 Onboarding extra revenue is within 15% of the independent check", async () => {
    const d = await loadDataset();
    const m = extraRevenueFromShipping(onb, d, 9);
    expect(m.usd).toBeGreaterThanOrEqual(16_490);
    expect(m.usd).toBeLessThanOrEqual(22_310);
    expect(m.usersMoved).toBeGreaterThan(0);
    expect(m.method).toMatch(/age-curve/);
  });
});
