/**
 * O'Brien-Fleming style stopping boundary and the peeking simulation behind AC-CALIB.
 *
 * Model: K equally spaced looks, independent N(0,1) increments under the null,
 * S_k = sum of the first k increments, z_k = S_k / sqrt(k). A false win is any look
 * k in 1..K with |z_k| > threshold_k (naive: 1.96; boundary: c * sqrt(K/k)).
 */

const NAIVE_THRESHOLD = 1.96;
/** Sims used by calibrateC. Fixed so the result is deterministic. */
export const CALIBRATION_SIMS = 40_000;
const C_LOW = 1.5;
const C_HIGH = 4;
const BISECTIONS = 40;

export function boundary(c: number, K: number, k: number): number {
  if (!Number.isInteger(K) || K < 1) throw new RangeError(`K must be an integer >= 1, got ${K}`);
  if (!Number.isInteger(k) || k < 1 || k > K) throw new RangeError(`k must be an integer in 1..${K}, got ${k}`);
  return c * Math.sqrt(K / k);
}

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws via Box-Muller (uses both values of each pair). */
function normalSource(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u1 = 1 - rand(); // (0, 1], avoids log(0)
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
}

/**
 * Per-sim statistics under the null: max over k of |z_k| and max over k of |z_k| * sqrt(k/K).
 * A sim is a false win under the naive rule iff maxAbsZ > 1.96, and under the boundary
 * with constant c iff maxScaledZ > c (|z_k| > c*sqrt(K/k) <=> |z_k|*sqrt(k/K) > c).
 */
function simulateStats(K: number, sims: number, seed: number): { maxAbsZ: Float64Array; maxScaledZ: Float64Array } {
  if (!Number.isInteger(K) || K < 1) throw new RangeError(`K must be an integer >= 1, got ${K}`);
  if (!Number.isInteger(sims) || sims < 1) throw new RangeError(`sims must be an integer >= 1, got ${sims}`);
  const normal = normalSource(mulberry32(seed));
  const maxAbsZ = new Float64Array(sims);
  const maxScaledZ = new Float64Array(sims);
  for (let i = 0; i < sims; i++) {
    let s = 0;
    let mz = 0;
    let ms = 0;
    for (let k = 1; k <= K; k++) {
      s += normal();
      const z = Math.abs(s) / Math.sqrt(k);
      if (z > mz) mz = z;
      const sc = z * Math.sqrt(k / K);
      if (sc > ms) ms = sc;
    }
    maxAbsZ[i] = mz;
    maxScaledZ[i] = ms;
  }
  return { maxAbsZ, maxScaledZ };
}

function fractionAbove(values: Float64Array, threshold: number): number {
  let n = 0;
  for (const v of values) if (v > threshold) n++;
  return n / values.length;
}

export function simulateFalseWins(opts: {
  K: number;
  rule: { kind: "boundary"; c: number } | { kind: "naive" };
  sims: number;
  seed: number;
}): number {
  const { maxAbsZ, maxScaledZ } = simulateStats(opts.K, opts.sims, opts.seed);
  return opts.rule.kind === "naive"
    ? fractionAbove(maxAbsZ, NAIVE_THRESHOLD)
    : fractionAbove(maxScaledZ, opts.rule.c);
}

/**
 * Finds c such that the boundary's false-win rate is the target, by fixed-iteration bisection
 * (BISECTIONS = 40, no tolerance exit) on [1.5, 4] over CALIBRATION_SIMS (40,000) seeded sims
 * reused across all iterations (common random numbers, so the rate is monotone in c).
 * Deterministic per seed.
 */
export function calibrateC(K: number, target = 0.05, seed = 1): number {
  const { maxScaledZ } = simulateStats(K, CALIBRATION_SIMS, seed);
  let lo = C_LOW;
  let hi = C_HIGH;
  for (let i = 0; i < BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    if (fractionAbove(maxScaledZ, mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Precomputed constants, rounded to 2 decimals. 15 is the brief's value; an independent 2M-sim
 * check puts the exact c for 5% at about 2.11, and calibrateC(15) (40k sims, seed 1) gives 2.128
 * from sampling noise. 10 and 20 are omitted: at 40k sims calibrateC is only good to about
 * +/-0.02, so those entries would not be trustworthy.
 */
export const C_TABLE: Readonly<Record<number, number>> = {
  15: 2.1,
};
