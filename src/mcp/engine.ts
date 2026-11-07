import type { AdaptyCli } from "../adapty/cli.js";
import type { AbTestDetail } from "../adapty/types.js";
import type { Dataset } from "../data/csv.js";
import type { Metric, TestPlan } from "../stats/plans.js";
import { judgeTest, testTimeline } from "../stats/verdict.js";
import { ToolError } from "./errors.js";
import type { JudgeFn, TimelineFn } from "./tools.js";

const METRICS: readonly string[] = ["rpi", "rpi_7d", "rpi_14d", "rpi_30d", "rpi_60d", "payer_rate"];

export function planForTitle(plans: readonly TestPlan[], title: string): TestPlan | undefined {
  return plans.find((p) => p.title === title);
}

/** Maps an Adapty arm id (flow_id) to its CSV flow via the arm's flow_name. UNKNOWN_ARM if the name is not in the plan. */
export function flowOfArm(plan: TestPlan, test: AbTestDetail, armId: string): string {
  const arm = test.arms.find((a) => a.armId === armId);
  if (!arm) throw new ToolError("UNKNOWN_ARM", `arm ${armId} is not part of test ${test.abTestId}`);
  const i = plan.adaptyFlowNames?.indexOf(arm.name) ?? -1;
  const flow = i >= 0 ? plan.arms[i] : undefined;
  if (flow === undefined) {
    throw new ToolError("UNKNOWN_ARM", `arm "${arm.name}" of test ${test.abTestId} is not part of the test plan "${plan.title}"`);
  }
  return flow;
}

function armIdOfFlow(plan: TestPlan, test: AbTestDetail, flow: string): string {
  for (const a of test.arms) if (flowOfArm(plan, test, a.armId) === flow) return a.armId;
  throw new ToolError("UNKNOWN_ARM", `no Adapty arm of test ${test.abTestId} maps to flow ${flow}`);
}

function parseMetric(raw: string | undefined): Metric | undefined {
  if (raw === undefined) return undefined;
  if (!METRICS.includes(raw)) throw new ToolError("INVALID_METRIC", `unknown metric "${raw}"; use one of ${METRICS.join(", ")}`);
  return raw as Metric;
}

/** The real verdict engine behind one shared judge and timeline: the gate and the tools both use these. */
export function createEngine(deps: {
  cli: Pick<AdaptyCli, "getTest">;
  plans: readonly TestPlan[];
  loadData: () => Promise<Dataset>;
}): { judge: JudgeFn; timeline: TimelineFn } {
  let data: Promise<Dataset> | undefined;
  const getData = (): Promise<Dataset> => {
    data ??= deps.loadData().catch((err: unknown) => {
      data = undefined; // do not memoize a failure
      throw err;
    });
    return data;
  };

  async function resolve(testId: string): Promise<{ test: AbTestDetail; plan: TestPlan }> {
    const test = await deps.cli.getTest(testId);
    const plan = planForTitle(deps.plans, test.title);
    if (!plan) throw new ToolError("NO_TEST_PLAN", `test "${test.title}" has no entry in test-plans.json, so it cannot be judged`);
    for (const a of test.arms) flowOfArm(plan, test, a.armId); // every arm must map
    return { test, plan };
  }

  const judge: JudgeFn = async (testId, opts) => {
    if (opts.source === "adapty_metrics") {
      throw new ToolError("NOT_IMPLEMENTED", "the adapty_metrics source is not implemented; use csv");
    }
    const metric = parseMetric(opts.metric);
    const { test, plan } = await resolve(testId);
    const v = judgeTest(plan, await getData(), {
      ...(opts.asOf ? { asOf: opts.asOf } : {}),
      ...(metric ? { metric } : {}),
    });
    return {
      verdict: v.verdict,
      reasons: v.reasons,
      ...(v.code ? { code: v.code } : {}),
      ...(v.winnerArm ? { winnerArmId: armIdOfFlow(plan, test, v.winnerArm) } : {}),
      goal_metric: v.goalMetric,
      look_k: v.lookK,
      K: v.K,
      K_source: v.KSource,
      horizon_days: v.horizonDays,
      z: v.z,
      boundary: v.boundary,
      effect: v.effect,
      p_naive: v.pNaive,
      arms: v.arms.map((a) => ({ arm: a.arm, n: a.n, rpi: a.rpi })),
      source: v.source,
    };
  };

  const timeline: TimelineFn = async (testId, opts) => {
    const metric = parseMetric(opts.metric);
    const { plan } = await resolve(testId);
    const t = testTimeline(plan, await getData(), metric ? { metric } : {});
    return {
      goal_metric: t.goalMetric,
      metric: t.metric,
      K: t.K,
      K_source: t.KSource,
      looks: t.looks.map((l) => ({
        k: l.k,
        date: l.date,
        z: l.z,
        boundary: l.boundary,
        crossed: l.crossed,
        leader: l.leader,
        p_naive: l.pNaive,
      })),
      ...(t.firstCrossing ? { first_crossing: t.firstCrossing } : {}),
      end: { date: t.end.date, leader: t.end.leader, effect: t.end.effect, p_naive: t.end.pNaive, arms: t.end.arms },
      source: t.source,
    };
  };

  return { judge, timeline };
}
