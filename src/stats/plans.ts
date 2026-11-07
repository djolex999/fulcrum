import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Dataset } from "../data/csv.js";

export const FALLBACK_K = 15;

export interface TestPlan {
  /** The Adapty test title this plan belongs to (exact match). */
  title: string;
  /** The ab_test title its users carry in the CSV export, when it differs from `title`. A throwaway rehearsal test reuses
   *  Onboarding's data this way, so it gets Onboarding's verdict. Defaults to `title`. */
  dataTitle?: string;
  arms: [string, string];
  /** Adapty flow_name of each arm, same order as `arms`. Needed to map Adapty arm ids to CSV flows. */
  adaptyFlowNames?: [string, string];
  goal: "rpi";
  /** null = revenue to date (no fixed horizon). */
  horizonDays: number | null;
  K?: number;
}

export type Metric = "rpi" | "rpi_7d" | "rpi_14d" | "rpi_30d" | "rpi_60d" | "payer_rate";

export class UnknownTestError extends Error {
  constructor(readonly title: string) {
    super(`Unknown test "${title}": no users in the dataset carry this ab_test title`);
    this.name = "UnknownTestError";
  }
}

/** The ab_test title whose CSV users this plan is judged on. */
export function dataTitleOf(plan: TestPlan): string {
  return plan.dataTitle ?? plan.title;
}

export const DEFAULT_PLANS_PATH = fileURLToPath(new URL("../../test-plans.json", import.meta.url));

/** The declared goal metric name, derived from the plan's horizon. */
export function goalMetricOf(plan: TestPlan): Metric {
  if (plan.horizonDays === null) return "rpi";
  const name = `rpi_${plan.horizonDays}d`;
  if (name === "rpi_7d" || name === "rpi_14d" || name === "rpi_30d" || name === "rpi_60d") return name;
  throw new Error(`Test "${plan.title}": horizonDays ${plan.horizonDays} has no metric name (use 7, 14, 30, 60 or null)`);
}

function parsePlan(raw: unknown, i: number): TestPlan {
  const bad = (why: string): Error => new Error(`test-plans.json entry ${i}: ${why}`);
  if (typeof raw !== "object" || raw === null) throw bad("not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== "string" || r.title === "") throw bad("missing title");
  const arms = r.arms;
  if (!Array.isArray(arms) || arms.length !== 2 || !arms.every((a) => typeof a === "string" && a !== "")) {
    throw bad(`"${r.title}" needs exactly two arm names`);
  }
  const names = r.adaptyFlowNames;
  if (names !== undefined && !(Array.isArray(names) && names.length === 2 && names.every((n) => typeof n === "string" && n !== ""))) {
    throw bad(`"${r.title}" adaptyFlowNames needs exactly two names`);
  }
  if (names !== undefined && names[0] === names[1]) throw bad(`"${r.title}" adaptyFlowNames must be two different names`);
  if (r.goal !== "rpi") throw bad(`"${r.title}" goal must be "rpi"`);
  const h = r.horizonDays;
  if (h !== null && !(typeof h === "number" && Number.isInteger(h) && h > 0)) {
    throw bad(`"${r.title}" horizonDays must be a positive integer or null`);
  }
  const K = r.K;
  if (K !== undefined && !(typeof K === "number" && Number.isInteger(K) && K >= 1)) {
    throw bad(`"${r.title}" K must be an integer >= 1`);
  }
  const dt = r.dataTitle;
  if (dt !== undefined && !(typeof dt === "string" && dt !== "")) throw bad(`"${r.title}" dataTitle must be a non-empty string`);
  const plan: TestPlan = { title: r.title, arms: [arms[0] as string, arms[1] as string], goal: "rpi", horizonDays: h };
  if (dt !== undefined) plan.dataTitle = dt;
  if (names !== undefined) plan.adaptyFlowNames = [names[0] as string, names[1] as string];
  if (K !== undefined) plan.K = K;
  goalMetricOf(plan);
  return plan;
}

/** Reads and validates the plans. With `data`, every plan's data title must exist in the dataset or UnknownTestError names it. */
export function loadPlans(path: string = DEFAULT_PLANS_PATH, data?: Dataset): TestPlan[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path} must be a JSON array of test plans`);
  const plans = parsed.map(parsePlan);
  if (data) {
    const titles = new Set(data.users.map((u) => u.abTest));
    for (const p of plans) if (!titles.has(dataTitleOf(p))) throw new UnknownTestError(dataTitleOf(p));
  }
  return plans;
}
