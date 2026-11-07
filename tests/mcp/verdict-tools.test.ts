import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const DUP: AbTestDetail = {
  ...ONB,
  abTestId: "t-dup",
  arms: [
    { armId: "fl-w1", name: "Onboarding - Weekly first" },
    { armId: "fl-w2", name: "Onboarding - Weekly first" },
  ],
};
const ODD: AbTestDetail = {
  ...ONB,
  abTestId: "t-odd",
  arms: [
    { armId: "fl-trial", name: "Onboarding - Annual trial" },
    { armId: "fl-mystery", name: "Mystery flow" },
  ],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fulcrum-vt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let dataset: Dataset | undefined;
const getData = async (): Promise<Dataset> => (dataset ??= await loadDataset());

async function setup(loadData: () => Promise<Dataset> = getData) {
  const tests = [ONB, SET, ODD, DUP];
  const cli = {
    listTests: async () => tests.map(({ arms: _a, ...s }) => s),
    getTest: async (id: string) => {
      const t = tests.find((x) => x.abTestId === id);
      if (!t) throw new Error("not found");
      return t;
    },
    stopTest: async () => ONB,
  };
  const { judge, timeline } = createEngine({ cli, plans, loadData });
  const gate = createGate({ cli, ledger: createLedger(join(dir, "ledger.jsonl")), judge });
  const server = buildServer({ cli, gate, judge, timeline, plans });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: res.isError === true, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { call };
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
async function onboardingLookDate(k: number): Promise<string> {
  const ds = await getData();
  const plan = plans[0]!;
  const first = Math.min(...ds.users.filter((u) => u.abTest === plan.title).map((u) => u.installAt.getTime()));
  return iso(new Date(Math.floor(first / DAY) * DAY + k * 7 * DAY));
}

describe.skipIf(!real)("real verdicts behind the MCP tools", () => {
  it("AC-2 request_stop on Onboarding at week 2 is blocked with BEFORE_HORIZON", async () => {
    const { call } = await setup();
    const r = await call("request_stop", {
      test_id: "t-onb",
      winner_arm_id: "fl-weekly",
      metric: "rpi_60d",
      rationale: "looks good",
      as_of: await onboardingLookDate(2),
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ status: "blocked", code: "BEFORE_HORIZON" });
  });

  it("AC-PEEK request_stop on Settings as_of 2026-08-16 shows the boundary", async () => {
    const { call } = await setup();
    const r = await call("request_stop", {
      test_id: "t-set",
      winner_arm_id: "fl-settings",
      metric: "rpi_30d",
      rationale: "p is under 0.05",
      as_of: "2026-08-16",
    });
    expect(r.json.status).toBe("blocked");
    const ev = r.json.evidence as { z: number; boundary: number; p_naive: number };
    expect(ev.boundary).toBeGreaterThan(3.2);
    expect(ev.boundary).toBeLessThan(3.45);
    expect(Math.abs(ev.z)).toBeLessThan(ev.boundary);
    expect(ev.p_naive).toBeLessThan(0.05);
  });

  it("AC-SHOP request_stop on Settings with payer_rate says metric shopping", async () => {
    const { call } = await setup();
    const r = await call("request_stop", {
      test_id: "t-set",
      winner_arm_id: "fl-settings",
      metric: "payer_rate",
      rationale: "payers went up",
    });
    expect(r.json).toMatchObject({ status: "blocked", code: "METRIC_NOT_GOAL" });
    expect(String(r.json.reason)).toContain("metric shopping");
  });

  it("request_stop on Onboarding live (no as_of) with the weekly-first arm is pending; with the trial arm it is blocked", async () => {
    const { call } = await setup();
    const win = await call("request_stop", { test_id: "t-onb", winner_arm_id: "fl-weekly", metric: "rpi_60d", rationale: "x" });
    expect(win.json).toMatchObject({ status: "pending", verdict: "WINNER", evidence: { verdict: "WINNER" } });
    const { call: call2 } = await setup();
    const lose = await call2("request_stop", { test_id: "t-onb", winner_arm_id: "fl-trial", metric: "rpi_60d", rationale: "x" });
    expect(lose.json.status).toBe("blocked");
  });

  it("judge_test returns source export_csv and goal_metric rpi_60d", async () => {
    const { call } = await setup();
    const r = await call("judge_test", { test_id: "t-onb" });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ source: "export_csv", goal_metric: "rpi_60d", horizon_days: 60, K_source: "test_plan" });
  });

  it("list_tests joins goal_metric and horizon_days from the plans", async () => {
    const { call } = await setup();
    const r = await call("list_tests");
    expect(r.json).toMatchObject({
      tests: [
        { test_id: "t-onb", goal_metric: "rpi_60d", horizon_days: 60 },
        { test_id: "t-set", goal_metric: "rpi_30d", horizon_days: 30 },
        { test_id: "t-odd" },
        { test_id: "t-dup" },
      ],
    });
  });

  it("test_timeline returns the looks on the goal metric", async () => {
    const { call } = await setup();
    const r = await call("test_timeline", { test_id: "t-set" });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ goal_metric: "rpi_30d", source: "export_csv" });
    expect((r.json.looks as unknown[]).length).toBeGreaterThan(5);
  });

  it("accepts a full ISO timestamp for as_of", async () => {
    const { call } = await setup();
    const r = await call("judge_test", { test_id: "t-set", as_of: "2026-08-16T00:00:00Z" });
    expect(r.isError).toBe(false);
    expect(r.json.look_k).toBeTruthy();
  });
});

describe("error mapping", () => {
  it("UNKNOWN_ARM for an arm name not in the plan", async () => {
    const { call } = await setup(async () => {
      throw new Error("data must not be needed");
    });
    const r = await call("request_stop", { test_id: "t-odd", winner_arm_id: "fl-mystery", metric: "rpi_60d", rationale: "x" });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("UNKNOWN_ARM");
    const j = await call("judge_test", { test_id: "t-odd" });
    expect(j.json.code).toBe("UNKNOWN_ARM");
  });

  it("duplicate Adapty arm names give UNKNOWN_ARM and never pending", async () => {
    const { call } = await setup(async () => {
      throw new Error("data must not be needed");
    });
    const r = await call("request_stop", { test_id: "t-dup", winner_arm_id: "fl-w1", metric: "rpi_60d", rationale: "x" });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("UNKNOWN_ARM");
    expect(String(r.json.message)).toContain("ambiguous");
    expect((await call("judge_test", { test_id: "t-dup" })).json.code).toBe("UNKNOWN_ARM");
  });

  it("duplicate adaptyFlowNames in a plan fail to load", () => {
    const f = join(dir, "plans.json");
    writeFileSync(f, JSON.stringify([{ title: "x", arms: ["a", "b"], adaptyFlowNames: ["Same", "Same"], goal: "rpi", horizonDays: 30 }]));
    expect(() => loadPlans(f)).toThrow(/different names/);
  });

  it("a judge failure returns blocked with no evidence that could contradict it", async () => {
    const { call } = await setup(async () => {
      throw new Error("transient load failure");
    });
    const r = await call("request_stop", { test_id: "t-onb", winner_arm_id: "fl-weekly", metric: "rpi_60d", rationale: "x" });
    expect(r.json.status).toBe("blocked");
    expect(String(r.json.reason)).toContain("judge failed");
    expect(r.json.evidence).toBeUndefined();
  });

  it("INTERNAL for a stats crash", async () => {
    const { call } = await setup(async () => {
      throw new Error("boom in the stats layer");
    });
    const r = await call("judge_test", { test_id: "t-onb" });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("INTERNAL");
  });
});
