import type { Txn, User } from "../data/csv.js";

const DAY_MS = 86_400_000;

/**
 * Per-user net revenue as of `cutoff`.
 * - Users installed after the cutoff are excluded; with a horizon, users installed
 *   less than `horizonDays` before the cutoff are excluded too (horizon not yet complete).
 * - A purchase counts if purchasedAt <= cutoff and, with a horizon, purchasedAt <= install + horizon.
 * - A refund subtracts priceUsd if refundedAt <= cutoff and, with a horizon, refundedAt <= install + horizon.
 * - Non-payers are included with 0.
 */
export function userRevenue(
  users: User[],
  txns: Txn[],
  opts: { cutoff: Date; horizonDays: number | null },
): Map<string, number> {
  const { cutoff, horizonDays } = opts;
  const cut = cutoff.getTime();
  const horizonMs = horizonDays === null ? null : horizonDays * DAY_MS;
  const installAt = new Map<string, number>();
  const revenue = new Map<string, number>();
  for (const u of users) {
    const t = u.installAt.getTime();
    if (t > cut) continue;
    if (horizonMs !== null && t + horizonMs > cut) continue;
    installAt.set(u.userId, t);
    revenue.set(u.userId, 0);
  }
  for (const x of txns) {
    const inst = installAt.get(x.userId);
    if (inst === undefined) continue;
    const end = horizonMs === null ? cut : Math.min(cut, inst + horizonMs);
    if (x.purchasedAt.getTime() > end) continue;
    let net = x.priceUsd;
    if (x.refundedAt !== null && x.refundedAt.getTime() <= end) net -= x.priceUsd;
    revenue.set(x.userId, (revenue.get(x.userId) ?? 0) + net);
  }
  return revenue;
}

/** Standard normal CDF via erfc (series for small arguments, continued fraction for the tail; ~1e-15 accuracy). */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const r = z < 2.5 ? 1 - erfSeries(z) : erfcContinuedFraction(z);
  return x >= 0 ? r : 2 - r;
}

function erfSeries(z: number): number {
  // erf(z) = 2/sqrt(pi) * sum_{n>=0} (-1)^n z^(2n+1) / (n! (2n+1))
  let term = z;
  let sum = z;
  for (let n = 1; n < 100; n++) {
    term *= (-z * z) / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) < 1e-17) break;
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}

function erfcContinuedFraction(z: number): number {
  // erfc(z) = exp(-z^2)/(z sqrt(pi)) * 1/(1+ 1/(2z^2)/(1+ 2/(2z^2)/(1+ ...))) (Lentz, evaluated backwards)
  let f = 0;
  for (let k = 60; k >= 1; k--) f = k / 2 / (z + f);
  return Math.exp(-z * z) / (Math.sqrt(Math.PI) * (z + f));
}

export interface WelchResult {
  meanA: number;
  meanB: number;
  diff: number;
  se: number;
  z: number;
  p: number;
  nA: number;
  nB: number;
}

function meanVar(xs: number[]): { mean: number; variance: number } {
  const n = xs.length;
  if (n === 0) return { mean: 0, variance: 0 };
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= n;
  if (n < 2) return { mean, variance: 0 };
  let ss = 0;
  for (const x of xs) ss += (x - mean) ** 2;
  return { mean, variance: ss / (n - 1) };
}

/**
 * Welch two-sample z (unequal variances), diff = meanB - meanA, two-sided normal p.
 * Degenerate rule: if either group has n < 2 or the standard error is 0, se = 0, z = 0, p = 1
 * (no evidence either way; never NaN). Empty groups have mean 0.
 */
export function welch(a: number[], b: number[]): WelchResult {
  const A = meanVar(a);
  const B = meanVar(b);
  const nA = a.length;
  const nB = b.length;
  const diff = B.mean - A.mean;
  const se = nA < 2 || nB < 2 ? 0 : Math.sqrt(A.variance / nA + B.variance / nB);
  if (se === 0) return { meanA: A.mean, meanB: B.mean, diff, se: 0, z: 0, p: 1, nA, nB };
  const z = diff / se;
  const p = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  return { meanA: A.mean, meanB: B.mean, diff, se, z, p, nA, nB };
}
