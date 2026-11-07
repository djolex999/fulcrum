import type { Dataset } from "../data/csv.js";
import { userRevenue } from "./rpi.js";
import type { TestPlan } from "./plans.js";
import { DAY_MS, judgeTest, lookEnd, planData } from "./verdict.js";

export interface ExtraRevenue {
  usd: number;
  usersMoved: number;
  method: string;
}

/**
 * Extra revenue from shipping the winner at look `atLook` (age-curve method).
 * C_arm(h) = cumulative net revenue per install by age h days, from the full data, over users
 * with at least h days of age. Each loser-arm user installed after the look's end would have
 * had the winner's experience instead: add C_winner(h_i) - C_loser(h_i), h_i = whole days from
 * install to dataEnd.
 */
export function extraRevenueFromShipping(plan: TestPlan, data: Dataset, atLook: number): ExtraRevenue {
  const pd = planData(plan, data);
  const end = lookEnd(pd, atLook);
  const v = judgeTest(plan, data, { asOf: end });
  if (v.lookK !== atLook || v.leader === null || v.code !== undefined) {
    throw new Error(`Test "${plan.title}": look ${atLook} is not a valid look (${v.code ?? "no leader"})`);
  }
  const winnerIdx = v.leader === plan.arms[0] ? 0 : 1;
  const winnerUsers = pd.users[winnerIdx] ?? [];
  const loserUsers = pd.users[1 - winnerIdx] ?? [];

  const curveCache = new Map<string, number>();
  const curve = (which: "w" | "l", h: number): number => {
    const key = `${which}${h}`;
    let c = curveCache.get(key);
    if (c === undefined) {
      const us = which === "w" ? winnerUsers : loserUsers;
      const rev = [...userRevenue(us, data.txns, { cutoff: data.dataEnd, horizonDays: h }).values()];
      c = rev.length === 0 ? 0 : rev.reduce((s, x) => s + x, 0) / rev.length;
      curveCache.set(key, c);
    }
    return c;
  };

  let usd = 0;
  let moved = 0;
  for (const u of loserUsers) {
    if (u.installAt.getTime() <= end.getTime()) continue;
    const h = Math.floor((data.dataEnd.getTime() - u.installAt.getTime()) / DAY_MS);
    usd += curve("w", h) - curve("l", h);
    moved++;
  }
  return {
    usd,
    usersMoved: moved,
    method: "age-curve: sum over loser-arm users installed after the look of C_winner(h) - C_loser(h), h = days from install to end of data",
  };
}
