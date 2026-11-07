import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AbTestDetail } from "../../src/adapty/types.js";
import { DEFAULT_DATA_DIR, loadDataset } from "../../src/data/csv.js";
import type { Dataset } from "../../src/data/csv.js";
import { createLedger } from "../../src/gate/ledger.js";
import { createGate } from "../../src/gate/pending.js";
import { createProposals } from "../../src/gate/proposals.js";
import { createEngine } from "../../src/mcp/engine.js";
import { buildServer } from "../../src/mcp/server.js";
import { loadPlans } from "../../src/stats/plans.js";
import { aiEditSignal } from "../../src/stats/signals.js";

const real = existsSync(DEFAULT_DATA_DIR);
const DAY = 86_400_000;
const plans = loadPlans();

const ONB: AbTestDetail = {
  abTestId: "t-onb",
  title: "Onboarding: annual trial vs weekly first",
  state: "live",
  placementTitle: "Onboarding",
  placementId: "pl-onb",
  arms: [
    { armId: "fl-trial", name: "Onboarding - Annual trial" },
    { armId: "fl-weekly", name: "Onboarding - Weekly first" },
  ],
};
const SET: AbTestDetail = {
  abTestId: "t-set",
  title: "Settings: upgrade vs lifetime anchor",
  state: "live",
  placementTitle: "Settings",
  placementId: "pl-set",
  arms: [
    { armId: "fl-lifetime", name: "Main - Lifetime anchor" },
    { armId: "fl-settings", name: "Settings - Upgrade" },
  ],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fulcrum-ux-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let dataset: Dataset | undefined;
const getData = async (): Promise<Dataset> => (dataset ??= await loadDataset());

async function setup() {
  const tests = [ONB, SET];
  const cli = {
    listTests: async () => tests.map(({ arms: _a, ...s }) => s),
    getTest: async (id: string) => {
      const t = tests.find((x) => x.abTestId === id);
      if (!t) throw new Error("not found");
      return t;
    },
    stopTest: async () => ONB,
    listPlacements: async () => [{ id: "pl-ai", developerId: "ai_limit_reached", title: "AI edits limit reached" }, { id: "pl-main", developerId: "main", title: "Main paywall" }],
    listFlows: async () => [{ id: "fl-pro", name: "AI limit reached - Pro", status: "published" }, { id: "fl-3p", name: "Main - 3 plans", status: "published" }],
  };
  const { judge, timeline } = createEngine({ cli, plans, loadData: getData });
  const gate = createGate({ cli, ledger: createLedger(join(dir, "ledger.jsonl")), judge });
  const proposals = createProposals({ cli, ledger: createLedger(join(dir, "ledger.jsonl")), policy: { ok: true, policy: { approvers: ["Djordje"], allowedPlacements: ["ai_limit_reached"], maxChallengerWeight: 50, fallbackK: 15, fallbackHorizonDays: null, dailyWriteLimit: 5 } } });
  const server = buildServer({ cli, gate, proposals, judge, timeline, signals: async () => ({ ...aiEditSignal(await getData()) }), plans, approvalUrl: "http://127.0.0.1:8787/" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: res.isError === true, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { call, client };
}

async function onboardingLookDate(k: number): Promise<string> {
  const ds = await getData();
  const plan = plans[0]!;
  const first = Math.min(...ds.users.filter((u) => u.abTest === plan.title).map((u) => u.installAt.getTime()));
  return new Date(Math.floor(first / DAY) * DAY + k * 7 * DAY).toISOString().slice(0, 10);
}

describe.skipIf(!real)("AGENT-UX every non-success reply names the next step", () => {
  it("AGENT-UX every non-success reply names the next step", async () => {
    const { call, client } = await setup();

    // (a) Onboarding at week 2: BEFORE_HORIZON with a date to ask again.
    const a = await call("request_stop", {
      test_id: "t-onb",
      winner_arm_id: "fl-weekly",
      metric: "rpi_60d",
      rationale: "x",
      as_of: await onboardingLookDate(2),
    });
    expect(a.json).toMatchObject({ status: "blocked", code: "BEFORE_HORIZON" });
    expect(String(a.json.reason)).toMatch(/ask again on\/after \d{4}-\d{2}-\d{2}/);
    const aJudge = await call("judge_test", { test_id: "t-onb", as_of: await onboardingLookDate(2) });
    expect(aJudge.json.next_look).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });

    // (b) Settings on 2026-08-16: boundary plus next look date.
    const b = await call("request_stop", {
      test_id: "t-set",
      winner_arm_id: "fl-settings",
      metric: "rpi_30d",
      rationale: "x",
      as_of: "2026-08-16",
    });
    expect(String(b.json.reason)).toContain("boundary");
    expect(String(b.json.reason)).toMatch(/Next valid look: look \d+, ends \d{4}-\d{2}-\d{2}; ask judge_test again then/);

    // (c) Settings with a non-goal metric: told which metric to ask for.
    const c = await call("request_stop", { test_id: "t-set", winner_arm_id: "fl-settings", metric: "payer_rate", rationale: "x" });
    expect(String(c.json.reason)).toContain("Ask judge_test for a verdict on rpi_30d");

    // (d) Live pending Onboarding request: who approves, where, and how to follow up.
    const d = await call("request_stop", { test_id: "t-onb", winner_arm_id: "fl-weekly", metric: "rpi_60d", rationale: "x" });
    expect(d.json.status).toBe("pending");
    expect(String(d.json.reason)).toContain("127.0.0.1");
    expect(String(d.json.reason)).toContain("request_status");
    expect(String(d.json.reason)).toContain(String(d.json.action_id));

    // (d2) propose_test: pending says the next step first; blocked cites the rule and says what to change.
    const p = await call("propose_test", { placement: "ai_limit_reached", flows: ["fl-pro", "fl-3p"], audience: "all", hypothesis: "5+ edits users pay twice as often" });
    expect(p.json.status).toBe("pending");
    expect(String(p.json.reason)).toMatch(/^Next: a human must approve at .*127\.0\.0\.1.*poll request_status with action_id /);
    const pb = await call("propose_test", { placement: "main", flows: ["fl-pro", "fl-3p"], audience: "all", hypothesis: "x" });
    expect(pb.json).toMatchObject({ status: "blocked", policy_rule: "allowed_placements" });
    expect(String(pb.json.reason)).toMatch(/propose the test on an allowed placement/);

    // (d3) find_signals names the next step.
    const fs = await call("find_signals");
    expect(String(fs.json.next_step)).toContain("propose_test");

    // (e) Every tool description is non-empty and points at a next step.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["find_signals", "judge_test", "list_tests", "propose_test", "request_status", "request_stop", "test_timeline"]);
    for (const t of tools) {
      expect(t.description ?? "").not.toBe("");
      const last = (t.description ?? "").split(". ").map((x) => x.trim()).filter((x) => x !== "").pop() ?? "";
      expect(last).toMatch(/\b(ask|poll|use|call|approve|keep)\b/i);
    }

  });
});
