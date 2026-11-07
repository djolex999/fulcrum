import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AbTestSummary } from "../../src/adapty/types.js";
import { checkCreate, DEFAULT_POLICY_PATH, loadPolicy, type Policy } from "../../src/policy/policy.js";

const GOOD = { approvers: ["Djordje"], allowedPlacements: ["ai_limit_reached"], maxChallengerWeight: 50, fallbackK: 15, fallbackHorizonDays: null, dailyWriteLimit: 5 };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fulcrum-policy-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (v: unknown): string => {
  const p = join(dir, "p.json");
  writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
  return p;
};

describe("AC-POLICY", () => {
  it("AC-POLICY the checked-in fulcrum.policy.json is valid", () => {
    const s = loadPolicy(DEFAULT_POLICY_PATH);
    expect(s).toMatchObject({ ok: true, policy: { approvers: ["Djordje"], allowedPlacements: ["ai_limit_reached"], maxChallengerWeight: 50, fallbackK: 15, fallbackHorizonDays: null, dailyWriteLimit: 5 } });
  });

  it("AC-POLICY a missing file fails closed", () => {
    const s = loadPolicy(join(dir, "nope.json"));
    expect(s.ok).toBe(false);
    expect(s.ok ? "" : s.reason).toContain("not found");
  });

  it.each([
    ["not JSON", "{oops"],
    ["not an object", "[]"],
    ["unknown field", { ...GOOD, extra: 1 }],
    ["no approvers", { ...GOOD, approvers: [] }],
    ["weight 0", { ...GOOD, maxChallengerWeight: 0 }],
    ["weight 100", { ...GOOD, maxChallengerWeight: 100 }],
    ["weight as text", { ...GOOD, maxChallengerWeight: "50" }],
    ["bad K", { ...GOOD, fallbackK: 0 }],
    ["bad horizon", { ...GOOD, fallbackHorizonDays: -3 }],
    ["bad limit", { ...GOOD, dailyWriteLimit: 1.5 }],
    ["missing field", { approvers: ["Djordje"] }],
  ])("AC-POLICY an invalid file fails closed: %s", (_n, v) => {
    const s = loadPolicy(write(v));
    expect(s.ok).toBe(false);
    expect(s.ok ? "" : s.reason).not.toBe("");
  });

  it("AC-POLICY every block cites its rule", () => {
    const policy = (loadPolicy(write(GOOD)) as { policy: Policy }).policy;
    const t = (title: string, state: AbTestSummary["state"]): AbTestSummary => ({ abTestId: title, title, state, placementTitle: "AI edits limit reached", placementId: "pl-ai" });
    const base = { placementDeveloperId: "ai_limit_reached", placementId: "pl-ai", challengerWeight: 50, writesToday: 0 };
    const rule = (r: ReturnType<typeof checkCreate>): string => (r.ok ? "ok" : r.rule);
    expect(rule(checkCreate(policy, base, []))).toBe("ok");
    expect(rule(checkCreate(policy, { ...base, placementDeveloperId: "main" }, []))).toBe("allowed_placements");
    expect(rule(checkCreate(policy, { ...base, challengerWeight: 80 }, []))).toBe("max_challenger_weight");
    expect(rule(checkCreate(policy, base, [t("x", "live")]))).toBe("live_test_on_placement");
    expect(rule(checkCreate(policy, { ...base, writesToday: 5 }, []))).toBe("daily_write_limit");
    const draft = checkCreate(policy, base, [t("AI limit: Pro vs 3 plans", "draft")]);
    expect(draft).toMatchObject({ ok: true, notes: [expect.stringContaining("AI limit: Pro vs 3 plans")] });
  });
});
