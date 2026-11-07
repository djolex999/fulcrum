import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DATA_DIR, loadDataset } from "../../src/data/csv.js";
import type { Dataset } from "../../src/data/csv.js";
import { dataTitleOf, loadPlans } from "../../src/stats/plans.js";
import type { TestPlan } from "../../src/stats/plans.js";
import { judgeTest, lookEnd, planData } from "../../src/stats/verdict.js";

// The throwaway rehearsal tests reuse Onboarding's flows and its CSV data (dataTitle), so a rehearsal stop
// through the real gate gets exactly Onboarding's verdict, without ever touching the Onboarding test.
const real = existsSync(DEFAULT_DATA_DIR);

describe.skipIf(!real)("throwaway rehearsal plans", () => {
  let data: Dataset;
  let plans: TestPlan[];
  beforeAll(async () => {
    data = await loadDataset();
    plans = loadPlans(undefined, data);
  });

  it("each throwaway plan is judged on Onboarding's data, with Onboarding's verdict", () => {
    const onb = plans.find((p) => p.title.startsWith("Onboarding"));
    const throwaways = plans.filter((p) => p.title.startsWith("Throwaway"));
    expect(onb).toBeDefined();
    expect(throwaways.length).toBe(3);
    for (const t of throwaways) {
      expect(dataTitleOf(t)).toBe(onb?.title);
      expect(t.title.toLowerCase().startsWith("onboarding")).toBe(false);
      const asOf = lookEnd(planData(t, data), 9);
      const v = judgeTest(t, data, { asOf });
      const o = judgeTest(onb as TestPlan, data, { asOf });
      expect(v.verdict).toBe("WINNER");
      expect(v.z).toBe(o.z);
      expect(v.winnerArm).toBe(o.winnerArm);
    }
  });

  it("a plan without dataTitle is judged on its own title", () => {
    const s = plans.find((p) => p.title.startsWith("Settings"));
    expect(s && dataTitleOf(s)).toBe(s?.title);
  });
});
