import type { Dataset, User } from "../data/csv.js";
import { boundary, C_TABLE, calibrateC } from "./boundary.js";
import { FALLBACK_K, goalMetricOf, UnknownTestError } from "./plans.js";
import type { Metric, TestPlan } from "./plans.js";
import { userRevenue, welch } from "./rpi.js";

export const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export type VerdictCode = "BEFORE_HORIZON" | "METRIC_NOT_GOAL" | "INVALID_AS_OF";

export interface ArmSummary {
  arm: string;
  n: number;
  rpi: number;
}

export interface Verdict {
  verdict: "WINNER" | "CONTINUE" | "NO_WINNER";
  code?: VerdictCode;
  goalMetric: string;
  goalSource: "test_plan";
  lookK: number | null;
  K: number;
  KSource: "test_plan" | "fallback";
  horizonDays: number | null;
  z: number | null;
  boundary: number | null;
  effect: number | null;
  pNaive: number | null;
  leader: string | null;
  winnerArm: string | null;
  arms: ArmSummary[];
  source: "export_csv";
  reasons: string[];
}

export interface TimelineLook {
  k: number;
  date: string;
  z: number | null;
  boundary: number;
  crossed: boolean;
  leader: string | null;
  pNaive: number | null;
}

export interface Timeline {
  goalMetric: string;
  /** The metric the looks are computed on; differs from goalMetric only when shown for explanation. */
  metric: Metric;
  K: number;
  KSource: "test_plan" | "fallback";
  looks: TimelineLook[];
  firstCrossing: { k: number; date: string; arm: string } | null;
  end: { date: string; leader: string; effect: number; pNaive: number; arms: { arm: string; n: number }[] };
  source: "export_csv";
}

const cCache = new Map<number, number>();
/** Boundary constant for K looks: the precomputed table, else a (memoized) simulation calibration. */
export function cFor(K: number): number {
  const known = C_TABLE[K];
  if (known !== undefined) return known;
  let c = cCache.get(K);
  if (c === undefined) {
    c = calibrateC(K);
    cCache.set(K, c);
  }
  return c;
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Everything a plan needs from the dataset: its two arms' users and the first install. */
export interface PlanData {
  users: [User[], User[]];
  firstInstall: number;
}

export function planData(plan: TestPlan, data: Dataset): PlanData {
  const inTest = data.users.filter((u) => u.abTest === plan.title);
  if (inTest.length === 0) throw new UnknownTestError(plan.title);
  const users: [User[], User[]] = [
    inTest.filter((u) => u.flow === plan.arms[0]),
    inTest.filter((u) => u.flow === plan.arms[1]),
  ];
  if (users[0].length === 0 || users[1].length === 0) {
    throw new Error(`Test "${plan.title}" has no users in arm "${users[0].length === 0 ? plan.arms[0] : plan.arms[1]}"`);
  }
  let first = Infinity;
  for (const us of users) for (const u of us) first = Math.min(first, u.installAt.getTime());
  // Looks are day-aligned: anchor at 00:00:00 UTC of the first-install day, so a date-only as_of lands on the intended look.
  const anchor = Math.floor(first / DAY_MS) * DAY_MS;
  return { users, firstInstall: anchor };
}

export function lookEnd(pd: PlanData, k: number): Date {
  return new Date(pd.firstInstall + k * WEEK_MS);
}

function horizonOf(plan: TestPlan, metric: Metric): number | null {
  switch (metric) {
    case "rpi":
      return null;
    case "rpi_7d":
      return 7;
    case "rpi_14d":
      return 14;
    case "rpi_30d":
      return 30;
    case "rpi_60d":
      return 60;
    case "payer_rate":
      return plan.horizonDays;
  }
}

interface LookStats {
  arms: ArmSummary[];
  z: number;
  p: number;
  effect: number;
  leader: string;
}

/** Per-arm values for `metric` as observable at `cutoff`. payer_rate = share of eligible users with positive net revenue. */
function armValues(plan: TestPlan, pd: PlanData, data: Dataset, metric: Metric, cutoff: Date): [number[], number[]] {
  const horizon = horizonOf(plan, metric);
  const out = pd.users.map((us) => {
    const rev = [...userRevenue(us, data.txns, { cutoff, horizonDays: horizon }).values()];
    return metric === "payer_rate" ? rev.map((r) => (r > 0 ? 1 : 0)) : rev;
  });
  return [out[0] as number[], out[1] as number[]];
}

function lookStats(plan: TestPlan, pd: PlanData, data: Dataset, metric: Metric, cutoff: Date): LookStats | null {
  const [a, b] = armValues(plan, pd, data, metric, cutoff);
  if (a.length < 2 || b.length < 2) return null;
  const w = welch(a, b);
  return {
    arms: [
      { arm: plan.arms[0], n: w.nA, rpi: w.meanA },
      { arm: plan.arms[1], n: w.nB, rpi: w.meanB },
    ],
    z: w.z,
    p: w.p,
    effect: w.diff,
    leader: w.meanB >= w.meanA ? plan.arms[1] : plan.arms[0],
  };
}

function armCounts(plan: TestPlan, pd: PlanData, data: Dataset, metric: Metric, cutoff: Date): ArmSummary[] {
  const [a, b] = armValues(plan, pd, data, metric, cutoff);
  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
  return [
    { arm: plan.arms[0], n: a.length, rpi: mean(a) },
    { arm: plan.arms[1], n: b.length, rpi: mean(b) },
  ];
}

function kInfo(plan: TestPlan): { K: number; KSource: "test_plan" | "fallback" } {
  return plan.K === undefined ? { K: FALLBACK_K, KSource: "fallback" } : { K: plan.K, KSource: "test_plan" };
}

const fmt = (x: number): string => x.toFixed(2);

/** First look at which both arms have at least 2 users with the full horizon, or null. */
function firstValidLook(plan: TestPlan, pd: PlanData, data: Dataset, metric: Metric, K: number): number | null {
  for (let k = 1; k <= K; k++) {
    if (lookStats(plan, pd, data, metric, lookEnd(pd, k)) !== null) return k;
  }
  return null;
}

export function judgeTest(plan: TestPlan, data: Dataset, opts: { asOf?: Date; metric?: Metric }): Verdict {
  const pd = planData(plan, data);
  const goal = goalMetricOf(plan);
  const { K, KSource } = kInfo(plan);
  const base = {
    goalMetric: goal,
    goalSource: "test_plan" as const,
    K,
    KSource,
    horizonDays: plan.horizonDays,
    source: "export_csv" as const,
  };
  const empty = {
    ...base,
    verdict: "CONTINUE" as const,
    lookK: null,
    z: null,
    boundary: null,
    effect: null,
    pNaive: null,
    leader: null,
    winnerArm: null,
    arms: [] as ArmSummary[],
  };

  if (opts.metric !== undefined && opts.metric !== goal) {
    return {
      ...empty,
      code: "METRIC_NOT_GOAL",
      reasons: [
        `Refused: metric shopping. "${opts.metric}" is not this test's declared goal; the declared goal is ${goal} (from the test plan).`,
        "A verdict is only ever computed on the declared goal metric.",
      ],
    };
  }

  const cutoffRaw = opts.asOf ?? data.dataEnd;
  const first = new Date(pd.firstInstall);
  if (cutoffRaw.getTime() < pd.firstInstall || cutoffRaw.getTime() > data.dataEnd.getTime()) {
    return {
      ...empty,
      code: "INVALID_AS_OF",
      reasons: [
        `as_of ${isoDate(cutoffRaw)} is outside the valid range ${isoDate(first)} to ${isoDate(data.dataEnd)} (first install day to end of data).`,
      ],
    };
  }

  const fullLooks = Math.floor((cutoffRaw.getTime() - pd.firstInstall) / WEEK_MS);
  if (fullLooks < 1) {
    return {
      ...empty,
      code: "BEFORE_HORIZON",
      reasons: [`No full weekly look has ended by ${isoDate(cutoffRaw)}; look 1 ends ${isoDate(lookEnd(pd, 1))}.`],
    };
  }
  const k = Math.min(fullLooks, K);
  const cutoff = lookEnd(pd, k);
  const stats = lookStats(plan, pd, data, goal, cutoff);

  if (stats === null) {
    const firstValid = firstValidLook(plan, pd, data, goal, K);
    const horizonText = plan.horizonDays === null ? "revenue to date" : `${plan.horizonDays}-day revenue`;
    return {
      ...empty,
      code: "BEFORE_HORIZON",
      lookK: k,
      arms: armCounts(plan, pd, data, goal, cutoff),
      reasons: [
        `Look ${k} of ${K} (ends ${isoDate(cutoff)}): fewer than 2 users per arm have the full ${horizonText} horizon yet, so ${goal} cannot be judged.`,
        firstValid === null
          ? `No planned look up to ${K} has a valid sample.`
          : `The first valid look is look ${firstValid} of ${K} (ends ${isoDate(lookEnd(pd, firstValid))}).`,
      ],
    };
  }

  const c = cFor(K);
  const bound = boundary(c, K, k);
  const crossed = Math.abs(stats.z) >= bound;
  const verdict: Verdict["verdict"] = crossed ? "WINNER" : k < K ? "CONTINUE" : "NO_WINNER";
  const where = `at look ${k} of ${K}`;
  const reasons = crossed
    ? [`|z| ${fmt(Math.abs(stats.z))} is at or above the boundary ${fmt(bound)} ${where}: ${stats.leader} wins on ${goal}.`]
    : [
        `z ${fmt(stats.z)} is below the boundary ${fmt(bound)} ${where}${k < K ? ": keep the test running." : ": last planned look reached, no winner."}`,
      ];
  if (!crossed && stats.p < 0.05) {
    reasons.push(`Naive p = ${stats.p.toFixed(3)} is under 0.05, but repeated looks inflate false wins; the boundary is what counts.`);
  }
  if (fullLooks > K) {
    const lastEnd = lookEnd(pd, K).getTime();
    let after = 0;
    for (const us of pd.users) for (const u of us) if (u.installAt.getTime() > lastEnd) after++;
    reasons.push(`The data runs past the last planned look: ${after} installs fall after look ${K} (ends ${isoDate(cutoff)}) and are not in this verdict.`);
  }
  if (KSource === "fallback") reasons.push(`The test plan gives no K; using the fallback K = ${FALLBACK_K}.`);

  return {
    ...base,
    verdict,
    lookK: k,
    z: stats.z,
    boundary: bound,
    effect: stats.effect,
    pNaive: stats.p,
    leader: stats.leader,
    winnerArm: crossed ? stats.leader : null,
    arms: stats.arms,
    reasons,
  };
}

export function testTimeline(plan: TestPlan, data: Dataset, opts: { metric?: Metric }): Timeline {
  const pd = planData(plan, data);
  const goal = goalMetricOf(plan);
  const metric = opts.metric ?? goal;
  const isGoal = metric === goal;
  const { K, KSource } = kInfo(plan);
  const c = cFor(K);
  const lastFull = Math.min(K, Math.floor((data.dataEnd.getTime() - pd.firstInstall) / WEEK_MS));

  const looks: TimelineLook[] = [];
  let firstCrossing: Timeline["firstCrossing"] = null;
  for (let k = 1; k <= lastFull; k++) {
    const end = lookEnd(pd, k);
    const s = lookStats(plan, pd, data, metric, end);
    const bound = boundary(c, K, k);
    // A non-goal metric is shown for explanation only: no row is ever marked as crossed.
    const crossed = isGoal && s !== null && Math.abs(s.z) >= bound;
    const look: TimelineLook = {
      k,
      date: isoDate(end),
      z: s?.z ?? null,
      boundary: bound,
      crossed,
      leader: s?.leader ?? null,
      pNaive: s?.p ?? null,
    };
    looks.push(look);
    if (crossed && firstCrossing === null && s !== null) {
      firstCrossing = { k, date: look.date, arm: s.leader };
    }
  }

  const endStats = lookStats(plan, pd, data, metric, data.dataEnd);
  if (endStats === null) throw new Error(`Test "${plan.title}": no arm has 2 users with the ${metric} horizon by the end of the data`);
  return {
    goalMetric: goal,
    metric,
    K,
    KSource,
    looks,
    firstCrossing,
    end: {
      date: isoDate(data.dataEnd),
      leader: endStats.leader,
      effect: endStats.effect,
      pNaive: endStats.p,
      arms: endStats.arms.map((a) => ({ arm: a.arm, n: a.n })),
    },
    source: "export_csv",
  };
}
