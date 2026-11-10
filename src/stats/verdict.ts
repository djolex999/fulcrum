// The verdict engine: given a test plan and the offline CSV, decide WINNER, CONTINUE or NO_WINNER.
// We look at the test once a week ("looks"), only on the test's declared goal metric, and only
// count users who have lived through the full horizon. A winner must beat a strict early bar
// (the boundary), so peeking every week does not hand out fake winners.
// judgeTest answers "what is the verdict now / as of a date"; testTimeline shows every weekly look.

import type { Dataset, User } from "../data/csv.js";
import { boundary, C_TABLE, calibrateC } from "./boundary.js";
import { dataTitleOf, FALLBACK_K, goalMetricOf, UnknownTestError } from "./plans.js";
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
  /** When to ask again (additive): the next look that can change this answer. Absent for WINNER and NO_WINNER. */
  nextLook?: { k: number; date: string };
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

// The boundary constant c depends only on K, so we compute it once per K and reuse it.
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

// Picks the test's users from the CSV and splits them into the plan's two arms.
export function planData(plan: TestPlan, data: Dataset): PlanData {
  const inTest = data.users.filter((u) => u.abTest === dataTitleOf(plan));
  if (inTest.length === 0) throw new UnknownTestError(dataTitleOf(plan));
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

// Look k ends exactly k weeks after the first install DAY at 00:00 UTC (day-aligned). That is why a
// date-only as_of such as "2026-08-16" lands exactly on a look instead of a few hours before it.
export function lookEnd(pd: PlanData, k: number): Date {
  return new Date(pd.firstInstall + k * WEEK_MS);
}

// How many days of revenue each user must have lived through for this metric to count.
// null = no horizon ("revenue to date"). Onboarding's goal is 60 days, Settings' is 30 days.
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

// Result of one look: per-arm means, Welch z, naive p, the effect (B minus A) and who leads.
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

// Returns null when either arm has fewer than 2 eligible users: too early to say anything.
// That is how "the horizon" shows up: with a 60-day goal, nobody is eligible in the first 8 weeks.
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

// K = number of planned weekly looks. If the plan has none we use the fallback (the policy's fallbackK,
// else the built-in FALLBACK_K) and say so openly.
function kInfo(plan: TestPlan, fallbackK: number = FALLBACK_K): { K: number; KSource: "test_plan" | "fallback" } {
  return plan.K === undefined ? { K: fallbackK, KSource: "fallback" } : { K: plan.K, KSource: "test_plan" };
}

const fmt = (x: number): string => x.toFixed(2);

/** First look at which both arms have at least 2 users with the full horizon, or null. */
function firstValidLook(plan: TestPlan, pd: PlanData, data: Dataset, metric: Metric, K: number): number | null {
  for (let k = 1; k <= K; k++) {
    if (lookStats(plan, pd, data, metric, lookEnd(pd, k)) !== null) return k;
  }
  return null;
}

// The decision, in order:
// 1. Wrong metric -> refuse ("metric shopping"). Only the declared goal can win a test.
// 2. as_of outside the data -> INVALID_AS_OF.
// 3. No full week yet, or nobody has the full horizon -> BEFORE_HORIZON ("not yet").
// 4. Otherwise compare |z| with the boundary: crossed = WINNER; not crossed = CONTINUE while looks
//    remain, NO_WINNER at the last look.
// Example, Onboarding (60-day goal): week 2 -> not yet, week 9 -> winner.
// Replay (asOf) uses the same code with an earlier cutoff, so past and present can't disagree.
export function judgeTest(plan: TestPlan, data: Dataset, opts: { asOf?: Date; metric?: Metric; fallbackK?: number }): Verdict {
  const pd = planData(plan, data);
  const goal = goalMetricOf(plan);
  const { K, KSource } = kInfo(plan, opts.fallbackK);
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

  // Metric shopping: if the agent can pick whichever metric makes a variant look good, some metric
  // will always look good. So we never judge anything but the goal from the test plan.
  if (opts.metric !== undefined && opts.metric !== goal) {
    return {
      ...empty,
      code: "METRIC_NOT_GOAL",
      reasons: [
        `Refused: metric shopping. "${opts.metric}" is not this test's declared goal; the declared goal is ${goal} (from the test plan).`,
        "A verdict is only ever computed on the declared goal metric.",
        `Ask judge_test for a verdict on ${goal} instead.`,
      ],
    };
  }

  // No as_of means "now", which in an offline dataset is the end of the data.
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

  // Only whole weeks count as looks. A date in the middle of week 9 is still look 8.
  const fullLooks = Math.floor((cutoffRaw.getTime() - pd.firstInstall) / WEEK_MS);
  if (fullLooks < 1) {
    return {
      ...empty,
      code: "BEFORE_HORIZON",
      nextLook: { k: 1, date: isoDate(lookEnd(pd, 1)) },
      reasons: [
        `No full weekly look has ended by ${isoDate(cutoffRaw)}; look 1 ends ${isoDate(lookEnd(pd, 1))}.`,
        `Ask again on/after ${isoDate(lookEnd(pd, 1))}.`,
      ],
    };
  }
  // Cap at K (k <= K): the plan only has K looks. If the data runs longer, the verdict is the one at
  // the last planned look; later installs are mentioned in the reasons but not counted.
  const k = Math.min(fullLooks, K);
  const cutoff = lookEnd(pd, k);
  const stats = lookStats(plan, pd, data, goal, cutoff);

  // Not enough eligible users yet (the horizon hasn't passed for them). Also reports which look is
  // the first valid one, so the agent knows when to ask again.
  if (stats === null) {
    const firstValid = firstValidLook(plan, pd, data, goal, K);
    const horizonText = plan.horizonDays === null ? "revenue to date" : `${plan.horizonDays}-day revenue`;
    return {
      ...empty,
      code: "BEFORE_HORIZON",
      lookK: k,
      arms: armCounts(plan, pd, data, goal, cutoff),
      ...(firstValid !== null ? { nextLook: { k: firstValid, date: isoDate(lookEnd(pd, firstValid)) } } : {}),
      reasons: [
        `Look ${k} of ${K} (ends ${isoDate(cutoff)}): fewer than 2 users per arm have the full ${horizonText} horizon yet, so ${goal} cannot be judged.`,
        firstValid === null
          ? `No planned look up to ${K} has a valid sample.`
          : `The first valid look is look ${firstValid} of ${K} (ends ${isoDate(lookEnd(pd, firstValid))}); ask again on/after ${isoDate(lookEnd(pd, firstValid))}.`,
      ],
    };
  }

  // Boundary check: the bar is c * sqrt(K / k), very high at look 1 and lowest at look K.
  const c = cFor(K);
  const bound = boundary(c, K, k);
  const crossed = Math.abs(stats.z) >= bound;
  // WINNER if crossed. If not, CONTINUE while more looks remain, NO_WINNER once the last look has passed.
  const verdict: Verdict["verdict"] = crossed ? "WINNER" : k < K ? "CONTINUE" : "NO_WINNER";
  const where = `at look ${k} of ${K}`;
  const next = !crossed && k < K ? { k: k + 1, date: isoDate(lookEnd(pd, k + 1)) } : undefined;
  const reasons = crossed
    ? [`|z| ${fmt(Math.abs(stats.z))} is at or above the boundary ${fmt(bound)} ${where}: ${stats.leader} wins on ${goal}.`]
    : [
        `z ${fmt(stats.z)} is below the boundary ${fmt(bound)} ${where}${k < K ? ": keep the test running." : ": last planned look reached, no winner."}`,
      ];
  if (next) reasons.push(`Next valid look: look ${next.k}, ends ${next.date}; ask judge_test again then.`);
  if (verdict === "NO_WINNER") {
    reasons.push(`All planned looks are used; no winner on ${goal}. Keep the current default or plan a new test.`);
  }
  // The classic peeking trap: naive p < 0.05 but still under the boundary. We say so out loud.
  if (!crossed && stats.p < 0.05) {
    reasons.push(`Naive p = ${stats.p.toFixed(3)} is under 0.05, but repeated looks inflate false wins; the boundary is what counts.`);
  }
  if (fullLooks > K) {
    const lastEnd = lookEnd(pd, K).getTime();
    let after = 0;
    for (const us of pd.users) for (const u of us) if (u.installAt.getTime() > lastEnd) after++;
    reasons.push(`The data runs past the last planned look: ${after} installs fall after look ${K} (ends ${isoDate(cutoff)}) and are not in this verdict.`);
  }
  if (KSource === "fallback") reasons.push(`The test plan gives no K; using the fallback K = ${K}.`);

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
    ...(next ? { nextLook: next } : {}),
    reasons,
  };
}

// Every weekly look in order, with z, boundary and whether it crossed. A non-goal metric is
// allowed here for explanation but is never marked as crossed.
// Two "end" views exist on purpose, and they can differ:
// - looks[] stops at look K (the last PLANNED look), the same view judgeTest gives.
// - end is computed on ALL data up to dataEnd, including installs after look K.
// Example, Settings: about -$0.91 / p 0.41 at look 15, about -$0.68 / p 0.50 at the end of the data.
export function testTimeline(plan: TestPlan, data: Dataset, opts: { metric?: Metric; fallbackK?: number }): Timeline {
  const pd = planData(plan, data);
  const goal = goalMetricOf(plan);
  const metric = opts.metric ?? goal;
  const isGoal = metric === goal;
  const { K, KSource } = kInfo(plan, opts.fallbackK);
  const c = cFor(K);
  // Show only whole weeks, and never more than K.
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

  // The "end" view: everything in the data, not only up to look K (see the note on testTimeline).
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
