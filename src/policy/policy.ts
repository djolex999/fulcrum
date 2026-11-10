// Policy for proposed tests, loaded from fulcrum.policy.json (no extra dependency). Missing or invalid = fail closed.
// checkCreate is pure: the gate hands it what it knows (live tests, how many writes ran today) and
// gets back either ok or the exact rule that blocks, so every block can cite its rule.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AbTestSummary } from "../adapty/types.js";

export interface Policy {
  /** Names allowed to approve a proposed test. */
  approvers: readonly string[];
  /** Placements a proposal may target, by developer_id (e.g. "ai_limit_reached"). */
  allowedPlacements: readonly string[];
  /** The challenger arm may get at most this share of traffic (percent, 1-99). */
  maxChallengerWeight: number;
  /** K (planned weekly looks) for a test that has no plan. Recorded here; not yet wired into the verdict engine. */
  fallbackK: number;
  /** Horizon for a test that has no plan, null = revenue to date. Not yet wired into the verdict engine. */
  fallbackHorizonDays: number | null;
  dailyWriteLimit: number;
}

/** A loaded policy, or the reason it could not be loaded. An invalid policy blocks every proposal (fail closed). */
export type PolicyState = { ok: true; policy: Policy } | { ok: false; reason: string };

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL("../../fulcrum.policy.json", import.meta.url));

const KEYS = ["approvers", "allowedPlacements", "maxChallengerWeight", "fallbackK", "fallbackHorizonDays", "dailyWriteLimit"];

const isNames = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "");
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Strict: unknown keys, wrong types or out-of-range numbers are all errors. Missing file or bad JSON too. */
export function loadPolicy(path: string = DEFAULT_POLICY_PATH): PolicyState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, reason: missing ? `policy file not found: ${path}` : `policy file is not valid JSON: ${path}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "policy must be a JSON object" };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!KEYS.includes(k)) return { ok: false, reason: `unknown policy field "${k}"` };
  if (!isNames(r.approvers)) return { ok: false, reason: "approvers must be a non-empty list of names" };
  if (!isNames(r.allowedPlacements)) return { ok: false, reason: "allowedPlacements must be a non-empty list of placement developer ids" };
  if (!isInt(r.maxChallengerWeight, 1, 99)) return { ok: false, reason: "maxChallengerWeight must be an integer from 1 to 99" };
  // Capped at a year of weekly looks: a K outside the calibration table is calibrated by simulation, and a huge K would stall it.
  if (!isInt(r.fallbackK, 1, 52)) return { ok: false, reason: "fallbackK must be an integer from 1 to 52" };
  if (r.fallbackHorizonDays !== null && !isInt(r.fallbackHorizonDays, 1)) return { ok: false, reason: "fallbackHorizonDays must be null or a positive integer" };
  if (!isInt(r.dailyWriteLimit, 0)) return { ok: false, reason: "dailyWriteLimit must be a non-negative integer" };
  return {
    ok: true,
    policy: {
      approvers: r.approvers,
      allowedPlacements: r.allowedPlacements,
      maxChallengerWeight: r.maxChallengerWeight,
      fallbackK: r.fallbackK,
      fallbackHorizonDays: r.fallbackHorizonDays,
      dailyWriteLimit: r.dailyWriteLimit,
    },
  };
}

export function isApprover(policy: Policy, name: string): boolean {
  const who = name.trim().toLowerCase();
  return who !== "" && policy.approvers.some((a) => a.trim().toLowerCase() === who);
}

export interface CreateProposal {
  placementDeveloperId: string;
  /** Live tests are matched to the placement by id (titles can differ in whitespace or length). */
  placementId: string;
  challengerWeight: number;
  /** Writes already executed today (UTC), counted by the gate from the ledger. */
  writesToday: number;
}

export type PolicyRule = "invalid_policy" | "allowed_placements" | "max_challenger_weight" | "live_test_on_placement" | "daily_write_limit";

export type PolicyResult =
  | {
      ok: true;
      /** Things the human and the agent should know that do not block, e.g. an existing draft. */
      notes: string[];
      /** The rules this proposal passed, in plain words, so the reply shows that policy decided. */
      passed: string[];
    }
  | { ok: false; rule: PolicyRule; reason: string };

export function checkCreate(policy: Policy, p: CreateProposal, liveTests: readonly AbTestSummary[]): PolicyResult {
  if (!policy.allowedPlacements.includes(p.placementDeveloperId)) {
    return {
      ok: false,
      rule: "allowed_placements",
      reason: `placement ${p.placementDeveloperId} is not allowed by policy (allowed: ${policy.allowedPlacements.join(", ") || "none"}); propose the test on an allowed placement`,
    };
  }
  if (p.challengerWeight > policy.maxChallengerWeight) {
    return {
      ok: false,
      rule: "max_challenger_weight",
      reason: `challenger weight ${p.challengerWeight} is above the policy maximum ${policy.maxChallengerWeight}; propose again with challenger_weight at most ${policy.maxChallengerWeight}`,
    };
  }
  // A test whose placement id is unknown cannot be ruled out, so it counts as being here (fail closed).
  const here = liveTests.filter((t) => t.placementId === undefined || t.placementId === p.placementId);
  const live = here.find((t) => t.state === "live");
  if (live) {
    return {
      ok: false,
      rule: "live_test_on_placement",
      reason: `a live test '${live.title}' is already running on this placement; wait until it is stopped, then propose again`,
    };
  }
  if (p.writesToday >= policy.dailyWriteLimit) {
    return {
      ok: false,
      rule: "daily_write_limit",
      reason: `the daily write limit (${policy.dailyWriteLimit}) is used up; propose again tomorrow`,
    };
  }
  const notes = here
    .filter((t) => t.state === "draft")
    .map((t) => `a draft test '${t.title}' already exists on this placement; this proposal does not touch it`);
  const passed = [
    `allowed placement: ${p.placementDeveloperId} is in allowedPlacements`,
    `traffic cap: challenger weight ${p.challengerWeight}% is within maxChallengerWeight ${policy.maxChallengerWeight}%`,
    "no live test on this placement",
    `daily write limit: ${p.writesToday} of ${policy.dailyWriteLimit} used today`,
  ];
  return { ok: true, notes, passed };
}
