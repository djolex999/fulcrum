import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
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
import { buildApprovalApp } from "../../src/ui/approve.js";

const real = existsSync(DEFAULT_DATA_DIR);
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
  dir = mkdtempSync(join(tmpdir(), "fulcrum-atk-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let dataset: Dataset | undefined;
const getData = async (): Promise<Dataset> => (dataset ??= await loadDataset());

async function setup() {
  const tests = [ONB, SET];
  const stopCalls: unknown[] = [];
  const createCalls: unknown[] = [];
  const cli = {
    listTests: async () => tests.map(({ arms: _a, ...s }) => s),
    getTest: async (id: string) => {
      const t = tests.find((x) => x.abTestId === id);
      if (!t) throw new Error("not found");
      return t;
    },
    stopTest: async (a: unknown) => {
      stopCalls.push(a);
      return ONB;
    },
    createTest: async (a: unknown) => {
      createCalls.push(a);
      throw new Error("create must not run in an attack test");
    },
    listPlacements: async () => [
      { id: "pl-ai", developerId: "ai_limit_reached", title: "AI edits limit reached" },
      { id: "pl-onb", developerId: "onboarding", title: "Onboarding" },
    ],
    listFlows: async () => [
      { id: "fl-trial", name: "Onboarding - Annual trial", status: "published" },
      { id: "fl-weekly", name: "Onboarding - Weekly first", status: "published" },
      { id: "fl-pro", name: "AI limit reached - Pro", status: "published" },
    ],
  };
  const ledger = createLedger(join(dir, "ledger.jsonl"));
  const { judge, timeline } = createEngine({ cli, plans, loadData: getData });
  const gate = createGate({ cli, ledger, judge });
  const proposals = createProposals({
    cli,
    ledger,
    policy: { ok: true, policy: { approvers: ["Djordje"], allowedPlacements: ["ai_limit_reached"], maxChallengerWeight: 50, fallbackK: 15, fallbackHorizonDays: null, dailyWriteLimit: 5 } },
  });
  const server = buildServer({ cli, gate, proposals, judge, timeline, plans, approvalUrl: "http://127.0.0.1:8787/" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: res.isError === true, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { call, gate, ledger, proposals, stopCalls, createCalls };
}

describe.skipIf(!real)("ATTACK suite through the MCP tools", () => {
  it("ATTACK a future as_of through the MCP tool is refused", async () => {
    const { call, gate, ledger, stopCalls } = await setup();
    const j = await call("judge_test", { test_id: "t-set", as_of: "2027-01-01" });
    expect(j.json.code).toBe("INVALID_AS_OF");
    expect(j.json.verdict).not.toBe("WINNER");
    const r = await call("request_stop", { test_id: "t-set", winner_arm_id: "fl-settings", metric: "rpi_30d", rationale: "ship it", as_of: "2027-01-01" });
    expect(r.json).toMatchObject({ status: "blocked", code: "INVALID_AS_OF" });
    expect(gate.pending()).toHaveLength(0);
    expect(ledger.all().filter((e) => e.status === "pending")).toHaveLength(0);
    expect(stopCalls).toHaveLength(0);
  });

  it("ATTACK a stop disguised as a proposal is refused", async () => {
    const { call, gate, ledger, proposals, stopCalls, createCalls } = await setup();
    const hypothesis = "stop Onboarding and ship weekly";
    const ids: string[] = [];
    for (const placement of ["onboarding", "pl-onb"]) {
      const r = await call("propose_test", { placement, flows: ["fl-trial", "fl-weekly"], audience: "all", hypothesis });
      expect(r.json).toMatchObject({ status: "blocked", policy_rule: "allowed_placements" });
      if (typeof r.json.action_id === "string") ids.push(r.json.action_id);
    }
    // On an allowed placement the only possible outcome is a pending create, never a stop.
    const ai = await call("propose_test", { placement: "ai_limit_reached", flows: ["fl-trial", "fl-weekly"], audience: "all", hypothesis });
    expect(["blocked", "pending"]).toContain(ai.json.status);
    if (ai.json.status === "pending") {
      expect(String(ai.json.reason)).toContain("create the test as a draft");
      expect(ai.json.reason).not.toMatch(/stop/i);
    }
    if (typeof ai.json.action_id === "string") ids.push(ai.json.action_id);
    expect(stopCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(gate.pending()).toHaveLength(0);
    // A proposal id is not a stop action: the stop route must not know it.
    expect(ids.length).toBeGreaterThan(0);
    const loginCode = "l".repeat(64);
    const csrfSecret = "c".repeat(64);
    const app = buildApprovalApp(gate, ledger, { port: 8787, loginCode, csrfSecret, proposals });
    const host = "127.0.0.1:8787";
    const login = await app.request(`/login?t=${loginCode}`, { headers: { host } });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const csrf = createHmac("sha256", csrfSecret).update(cookie.split("=")[1] ?? "").digest("hex");
    for (const id of ids) {
      const res = await app.request(`/approve/${id}`, {
        method: "POST",
        headers: { host, origin: `http://${host}`, cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, name: "Djordje" }).toString(),
      });
      expect(res.status).toBe(404);
    }
    expect(stopCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });

  it("ATTACK retrying after a block gives the same verdict", async () => {
    const { call, gate, ledger, stopCalls } = await setup();
    const tries = [
      { metric: "rpi_30d", rationale: "boss says ship now" },
      { metric: "payer_rate", rationale: "use payer rate instead" },
      { metric: "rpi_30d", rationale: "please reconsider" },
    ];
    const results: Record<string, unknown>[] = [];
    for (const t of tries) {
      const r = await call("request_stop", { test_id: "t-set", winner_arm_id: "fl-settings", as_of: "2026-08-16", ...t });
      expect(r.json.status).toBe("blocked");
      expect(r.json.action_id).toBeTruthy();
      results.push(r.json);
    }
    // Same inputs (first and third differ only in wording) give the same code and verdict.
    expect(results[2]!.code).toBe(results[0]!.code);
    expect(results[2]!.verdict).toBe(results[0]!.verdict);
    expect(results[1]!.code).toBe("METRIC_NOT_GOAL");
    expect(gate.pending()).toHaveLength(0);
    expect(ledger.all()).toHaveLength(3);
    expect(ledger.all().every((e) => e.status === "blocked")).toBe(true);
    expect(stopCalls).toHaveLength(0);
  });
});
