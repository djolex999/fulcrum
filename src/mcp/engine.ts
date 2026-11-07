// Glue between Adapty and the statistics. Adapty talks about "arms" (flow ids); the CSV and the stats
// code talk about "flows" (names). This file translates both ways and builds the one judge and
// one timeline function that the MCP tools and the approval gate share.

import type { AdaptyCli } from "../adapty/cli.js";
import type { AbTestDetail } from "../adapty/types.js";
import type { Dataset } from "../data/csv.js";
import type { Metric, TestPlan } from "../stats/plans.js";
import { judgeTest, testTimeline } from "../stats/verdict.js";
import { ToolError } from "./errors.js";
import type { JudgeFn, TimelineFn } from "./tools.js";

// The only metric names the engine accepts. An unknown name is INVALID_METRIC; a known name that
// isn't the test's goal is refused later by the judge as metric shopping.
const METRICS: readonly string[] = ["rpi", "rpi_7d", "rpi_14d", "rpi_30d", "rpi_60d", "payer_rate"];

export function planForTitle(plans: readonly TestPlan[], title: string): TestPlan | undefined {
  return plans.find((p) => p.title === title);
}

// Chain: arm id -> arm's Adapty flow name -> position in plan.adaptyFlowNames -> same position in plan.arms (the CSV flow).
/** Maps an Adapty arm id (flow_id) to its CSV flow via the arm's flow_name. UNKNOWN_ARM if the name is not in the plan. */
/** Agent UX: an UNKNOWN_ARM reply lists the valid arm ids, so the agent can retry with the right one. */
export function validArmsHint(test: AbTestDetail, plan?: TestPlan): string {
  const list = test.arms.map((a) => {
    const i = plan?.adaptyFlowNames?.indexOf(a.name) ?? -1;
    const planArm = plan && i >= 0 ? `, plan arm ${plan.arms[i]}` : "";
    return `${a.armId} ("${a.name}"${planArm})`;
  });
  return `Next: winner_arm_id must be one of: ${list.join("; ")}`;
}

export function flowOfArm(plan: TestPlan, test: AbTestDetail, armId: string): string {
  const arm = test.arms.find((a) => a.armId === armId);
  if (!arm) throw new ToolError("UNKNOWN_ARM", `arm ${armId} is not part of test ${test.abTestId}. ${validArmsHint(test, plan)}`);
  const i = plan.adaptyFlowNames?.indexOf(arm.name) ?? -1;
  const flow = i >= 0 ? plan.arms[i] : undefined;
  if (flow === undefined) {
    throw new ToolError("UNKNOWN_ARM", `arm "${arm.name}" of test ${test.abTestId} is not part of the test plan "${plan.title}"`);
  }
  return flow;
}

// Why a bijection: if both Adapty arms mapped to the same CSV flow, the judge would compare an arm with
// itself and could name the wrong winner. A mistake here must stop everything, not give a wrong answer.
/** The Adapty-arm to CSV-flow mapping must be a bijection: two arms, distinct flows, covering both plan arms. */
export function checkArmMapping(plan: TestPlan, test: AbTestDetail): void {
  const flows = test.arms.map((a) => flowOfArm(plan, test, a.armId));
  if (test.arms.length !== 2 || new Set(flows).size !== 2 || !plan.arms.every((f) => flows.includes(f))) {
    throw new ToolError("UNKNOWN_ARM", `arm mapping is ambiguous for test ${test.abTestId}: its arms must map to the plan's two flows exactly once`);
  }
}

// The reverse trip: the stats name a winning CSV flow, and the stop needs the Adapty arm id.
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
  // The CSV is loaded lazily and once (50,000 users). We cache the promise, not the result, so
  // concurrent callers share one load; a failed load is forgotten so it can be retried.
  let data: Promise<Dataset> | undefined;
  const getData = (): Promise<Dataset> => {
    data ??= deps.loadData().catch((err: unknown) => {
      data = undefined; // do not memoize a failure
      throw err;
    });
    return data;
  };

  // Every judge/timeline call re-reads the test from Adapty and re-checks the arm mapping, so a test whose arms were changed can't be judged with a stale mapping.
  async function resolve(testId: string): Promise<{ test: AbTestDetail; plan: TestPlan }> {
    const test = await deps.cli.getTest(testId);
    const plan = planForTitle(deps.plans, test.title);
    if (!plan) throw new ToolError("NO_TEST_PLAN", `test "${test.title}" has no entry in test-plans.json, so it cannot be judged`);
    checkArmMapping(plan, test);
    return { test, plan };
  }

  // The one judge. The gate uses it (request and approval re-check) and so does the judge_test tool,
  // so they can never disagree about the same data.
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
      // Translate the winning CSV flow back to the Adapty arm id. The gate compares THIS to the arm the agent asked for.
      ...(v.winnerArm ? { winnerArmId: armIdOfFlow(plan, test, v.winnerArm) } : {}),
      // From here on: the same verdict in the snake_case names of the public tool contract (SPEC).
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
      ...(v.nextLook ? { next_look: v.nextLook } : {}),
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
