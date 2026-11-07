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
import { createEngine } from "../../src/mcp/engine.js";
import { buildServer } from "../../src/mcp/server.js";
import { loadPlans } from "../../src/stats/plans.js";

const real = existsSync(DEFAULT_DATA_DIR);
const DAY = 86_400_000;
const plans = loadPlans();

const ONB: AbTestDetail = {
  abTestId: "t-onb",
  title: "Onboarding: annual trial vs weekly first",
  state: "live",
  placementTitle: "Onboarding",
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
  };
  const { judge, timeline } = createEngine({ cli, plans, loadData: getData });
  const gate = createGate({ cli, ledger: createLedger(join(dir, "ledger.jsonl")), judge });
  const server = buildServer({ cli, gate, judge, timeline, plans, approvalUrl: "http://127.0.0.1:8787/" });
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

    // (e) Every tool description is non-empty and points at a next step.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["judge_test", "list_tests", "request_status", "request_stop", "test_timeline"]);
    for (const t of tools) {
      expect(t.description ?? "").not.toBe("");
      expect(t.description).toMatch(/\b(use|ask|poll|read|keep polling)\b/i);
    }

  });
});
