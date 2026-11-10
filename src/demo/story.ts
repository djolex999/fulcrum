// The demo story as data: three pieces of evidence, all computed from the offline dataset and the
// declared test plans (nothing hard-coded except which test, which look and the simulation settings).
// scripts/demo-story.ts only prints this; tests check it.

import type { Dataset } from "../data/csv.js";
import { simulateFalseWins } from "../stats/boundary.js";
import { extraRevenueFromShipping } from "../stats/money.js";
import type { TestPlan } from "../stats/plans.js";
import { cFor, isoDate, judgeTest, lookEnd, planData, testTimeline } from "../stats/verdict.js";

/** The settings look the story points at (look ending 2026-08-16). */
export const MARKED_DATE = "2026-08-16";
/** The onboarding look shown as "not yet". */
export const ONBOARDING_EARLY_LOOK = 2;
export const SIM_COUNT = 200_000;
export const SIM_SEED = 1;

export interface StoryLook {
  k: number;
  date: string;
  nA: number;
  nB: number;
  z: number | null;
  boundary: number;
  pNaive: number | null;
  crossed: boolean;
}

export interface Story {
  settings: {
    test: string;
    goalMetric: string;
    arms: [string, string];
    K: number;
    looks: StoryLook[];
    marked: { look: StoryLook; leader: string; shippedByPeeker: string };
    lastLook: { k: number; verdict: string; pNaive: number | null };
    end: { date: string; leader: string; pNaive: number };
  };
  simulation: { K: number; c: number; sims: number; seed: number; naive: number; boundary: number };
  onboarding: {
    test: string;
    goalMetric: string;
    notYet: { asOf: string; code: string | null; nextLookDate: string | null; reason: string };
    now: { k: number; date: string; z: number; boundary: number; winnerArm: string };
    moneyUsd: number;
  };
}

function findPlan(plans: TestPlan[], prefix: string): TestPlan {
  const p = plans.find((x) => x.title.startsWith(prefix));
  if (!p) throw new Error(`No test plan starting with "${prefix}"`);
  return p;
}

/** `fallbackK` is the policy's (see fallbackKOf), so the story uses the same K as the server for a plan without K. */
export function buildStory(data: Dataset, plans: TestPlan[], opts: { fallbackK?: number } = {}): Story {
  // 1. Settings: every weekly look on the declared goal.
  const sPlan = findPlan(plans, "Settings");
  const sPd = planData(sPlan, data);
  const tl = testTimeline(sPlan, data, opts);
  const armN = (asOf: Date): [number, number] => {
    const v = judgeTest(sPlan, data, { ...opts, asOf });
    return [v.arms[0]?.n ?? 0, v.arms[1]?.n ?? 0];
  };
  const looks: StoryLook[] = tl.looks.map((l) => {
    const [nA, nB] = armN(lookEnd(sPd, l.k));
    return { k: l.k, date: l.date, nA, nB, z: l.z, boundary: l.boundary, pNaive: l.pNaive, crossed: l.crossed };
  });
  const marked = looks.find((l) => l.date === MARKED_DATE);
  if (!marked) throw new Error(`No Settings look ends ${MARKED_DATE}`);
  const markedRaw = tl.looks.find((l) => l.k === marked.k);
  const last = tl.looks[tl.looks.length - 1];
  if (!last) throw new Error("Settings timeline has no looks");
  const lastVerdict = judgeTest(sPlan, data, { ...opts, asOf: lookEnd(sPd, last.k) });

  // 2. The simulation: K looks, same seeded A/A draws for both rules.
  const K = tl.K;
  const c = cFor(K);
  const simBase = { K, sims: SIM_COUNT, seed: SIM_SEED };
  const naive = simulateFalseWins({ ...simBase, rule: { kind: "naive" } });
  const bound = simulateFalseWins({ ...simBase, rule: { kind: "boundary", c } });

  // 3. Onboarding: week 2 not yet, first valid look "now", and the money.
  const oPlan = findPlan(plans, "Onboarding");
  const oPd = planData(oPlan, data);
  const earlyEnd = lookEnd(oPd, ONBOARDING_EARLY_LOOK);
  const early = judgeTest(oPlan, data, { asOf: earlyEnd });
  const nowK = early.nextLook?.k;
  if (early.verdict !== "CONTINUE" || early.code !== "BEFORE_HORIZON" || nowK === undefined) {
    throw new Error(`Onboarding look ${ONBOARDING_EARLY_LOOK} is not a "not yet" answer`);
  }
  const nowV = judgeTest(oPlan, data, { asOf: lookEnd(oPd, nowK) });
  if (nowV.verdict !== "WINNER" || nowV.z === null || nowV.boundary === null || nowV.winnerArm === null) {
    throw new Error(`Onboarding look ${nowK} is not a winner`);
  }
  const money = extraRevenueFromShipping(oPlan, data, nowK);

  return {
    settings: {
      test: sPlan.title,
      goalMetric: tl.goalMetric,
      arms: sPlan.arms,
      K,
      looks,
      marked: { look: marked, leader: markedRaw?.leader ?? "", shippedByPeeker: markedRaw?.leader ?? "" },
      lastLook: { k: last.k, verdict: lastVerdict.verdict, pNaive: last.pNaive },
      end: { date: tl.end.date, leader: tl.end.leader, pNaive: tl.end.pNaive },
    },
    simulation: { K, c, sims: SIM_COUNT, seed: SIM_SEED, naive, boundary: bound },
    onboarding: {
      test: oPlan.title,
      goalMetric: nowV.goalMetric,
      notYet: {
        asOf: isoDate(earlyEnd),
        code: early.code ?? null,
        nextLookDate: early.nextLook?.date ?? null,
        reason: early.reasons[0] ?? "",
      },
      now: { k: nowK, date: isoDate(lookEnd(oPd, nowK)), z: nowV.z, boundary: nowV.boundary, winnerArm: nowV.winnerArm },
      moneyUsd: money.usd,
    },
  };
}
