import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdaptyCliError, createAdaptyCli, type Runner } from "../../src/adapty/cli.js";
import type { AbTestDetail, AbTestSummary, ApprovedCreate, Flow, Placement } from "../../src/adapty/types.js";
import { DEFAULT_DATA_DIR, loadDataset } from "../../src/data/csv.js";
import { createLedger } from "../../src/gate/ledger.js";
import { createGate } from "../../src/gate/pending.js";
import { createProposals } from "../../src/gate/proposals.js";
import type { Policy, PolicyState } from "../../src/policy/policy.js";
import { buildServer } from "../../src/mcp/server.js";
import { placeholderJudge, placeholderTimeline } from "../../src/mcp/tools.js";
import { aiEditSignal } from "../../src/stats/signals.js";
import { buildApprovalApp } from "../../src/ui/approve.js";

const real = existsSync(DEFAULT_DATA_DIR);

const PLACEMENTS: Placement[] = [
  { id: "pl-ai", developerId: "ai_limit_reached", title: "AI edits limit reached" },
  { id: "pl-main", developerId: "main", title: "Main paywall" },
];
const FLOWS: Flow[] = [
  { id: "fl-pro", name: "AI limit reached - Pro", status: "published" },
  { id: "fl-3p", name: "Main - 3 plans", status: "published" },
];
const sum = (title: string, state: AbTestSummary["state"], placementTitle: string): AbTestSummary => ({ abTestId: `id-${title}`, title, state, placementTitle });
const STARTED: AbTestDetail = { abTestId: "new-1", title: "x", state: "live", placementTitle: "AI edits limit reached", arms: [] };
const PROPOSAL = { placement: "ai_limit_reached", flows: ["fl-pro", "fl-3p"], audience: "all", hypothesis: "5+ edits users pay about twice as often" };

let dir: string;
let tests: AbTestSummary[];
let order: string[];
let created: ApprovedCreate[];
let createImpl: () => Promise<{ abTestId: string }>;
let policyState: PolicyState;

const POLICY: Policy = {
  approvers: ["Djordje"],
  allowedPlacements: ["ai_limit_reached"],
  maxChallengerWeight: 50,
  fallbackK: 15,
  fallbackHorizonDays: null,
  dailyWriteLimit: 5,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fulcrum-prop-"));
  tests = [sum("Main: 3 plans vs lifetime anchor", "live", "Main paywall")];
  order = [];
  created = [];
  createImpl = async () => ({ abTestId: "new-1" });
  policyState = { ok: true, policy: POLICY };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function setup() {
  const ledger = createLedger(join(dir, "ledger.jsonl"));
  const cli = {
    listTests: async () => tests,
    getTest: async (): Promise<AbTestDetail> => STARTED,
    stopTest: async (): Promise<AbTestDetail> => STARTED,
    listPlacements: async () => PLACEMENTS,
    listFlows: async () => FLOWS,
    createTest: async (a: ApprovedCreate) => {
      order.push("create");
      created.push(a);
      return createImpl();
    },
  };
  const gate = createGate({ cli, ledger, judge: placeholderJudge });
  const proposals = createProposals({ cli, ledger, policy: policyState });
  const server = buildServer({ cli, gate, proposals, judge: placeholderJudge, timeline: placeholderTimeline, approvalUrl: "http://127.0.0.1:8787/" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: res.isError === true, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { call, gate: proposals, ledger, stopGate: gate };
}

describe("propose_test through the gate", () => {
  it("AC-LOOP propose_test queues a pending create after policy check", async () => {
    const { call, gate, ledger } = await setup();
    const r = await call("propose_test", PROPOSAL);
    expect(r.json).toMatchObject({ status: "pending" });
    expect(String(r.json.reason)).toMatch(/^Next: a human must approve at http:\/\/127\.0\.0\.1:8787\/; poll request_status with action_id /);
    expect(gate.pending()).toHaveLength(1);
    expect(order).toEqual([]);
    const entries = ledger.all().filter((e) => e.id === r.json.action_id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: "request_create", status: "pending" });
    const s = await call("request_status", { action_id: r.json.action_id });
    expect(s.json).toMatchObject({ kind: "propose_test", status: "pending" });
  });

  it("AC-LOOP approved proposal runs create only, once, never start", async () => {
    const { call, gate } = await setup();
    const r = await call("propose_test", { ...PROPOSAL, challenger_weight: 40, audience: "seg-5plus" });
    const id = String(r.json.action_id);
    const first = await gate.approve(id, "Djordje");
    expect(first.status).toBe("executed");
    const second = await gate.approve(id, "Djordje");
    expect(second.reason).toBe("already executed");
    expect(order).toEqual(["create"]);
    expect(created[0]).toMatchObject({
      placementId: "pl-ai",
      audience: { segmentId: "seg-5plus" },
      flows: [{ flowId: "fl-pro", weight: 60, title: "A" }, { flowId: "fl-3p", weight: 40, title: "B" }],
    });
    expect(created[0]?.goal).toBe("goal: rpi_60d; horizon_days: 60; K: 15; hypothesis: 5+ edits users pay about twice as often");
    const s = await call("request_status", { action_id: id });
    expect(s.json).toMatchObject({ status: "executed", created_test_id: "new-1", approved_by: "Djordje" });
    expect(String(s.json.reason)).toContain("starting it is your decision in Adapty");
  });

  it("AC-LOOP concurrent approvals create once", async () => {
    const { call, gate } = await setup();
    const id = String((await call("propose_test", PROPOSAL)).json.action_id);
    await Promise.all([gate.approve(id, "Djordje"), gate.approve(id, "Djordje")]);
    expect(order).toEqual(["create"]);
  });

  it("AC-LOOP blocked with policy_rule for a disallowed placement", async () => {
    const { call } = await setup();
    const r = await call("propose_test", { ...PROPOSAL, placement: "main" });
    expect(r.json).toMatchObject({ status: "blocked", policy_rule: "allowed_placements" });
  });

  it("AC-LOOP blocked with policy_rule for challenger weight 80", async () => {
    const { call } = await setup();
    const r = await call("propose_test", { ...PROPOSAL, challenger_weight: 80 });
    expect(r.json).toMatchObject({ status: "blocked", policy_rule: "max_challenger_weight" });
    expect(String(r.json.reason)).toContain("80");
  });

  it("AC-LOOP blocked with policy_rule for a live test on the placement", async () => {
    tests.push(sum("AI limit: live one", "live", "AI edits limit reached"));
    const { call } = await setup();
    const r = await call("propose_test", PROPOSAL);
    expect(r.json).toMatchObject({ status: "blocked", policy_rule: "live_test_on_placement" });
    expect(String(r.json.reason)).toContain("AI limit: live one");
  });

  it("AC-LOOP an existing draft on the placement is named but does not block", async () => {
    tests.push(sum("AI limit: Pro vs 3 plans", "draft", "AI edits limit reached"));
    const { call, gate } = await setup();
    const r = await call("propose_test", PROPOSAL);
    expect(r.json.status).toBe("pending");
    expect(String(r.json.reason)).toContain("a draft test 'AI limit: Pro vs 3 plans' already exists on this placement; this proposal does not touch it");
    expect(r.json.existing_draft).toHaveLength(1);
    expect(gate.pending()[0]?.reason).toContain("AI limit: Pro vs 3 plans");
  });

  it("AC-LOOP unknown placement and unknown flow are errors", async () => {
    const { call } = await setup();
    expect((await call("propose_test", { ...PROPOSAL, placement: "nope" })).json.code).toBe("UNKNOWN_PLACEMENT");
    expect((await call("propose_test", { ...PROPOSAL, flows: ["fl-pro", "nope"] })).json.code).toBe("UNKNOWN_FLOW");
  });

  it("AC-LOOP a second proposal on the same placement is DUPLICATE_PENDING", async () => {
    const { call, ledger } = await setup();
    await call("propose_test", PROPOSAL);
    const r = await call("propose_test", PROPOSAL);
    expect(r.json.code).toBe("DUPLICATE_PENDING");
    expect(ledger.all().filter((e) => e.tool === "request_create")).toHaveLength(2);
  });

  it("AC-LOOP approver not in policy is refused", async () => {
    const { call, gate } = await setup();
    const id = String((await call("propose_test", PROPOSAL)).json.action_id);
    const r = await gate.approve(id, "mallory");
    expect(r.status).toBe("pending");
    expect(r.reason).toContain("not in the policy approvers");
    expect(order).toEqual([]);
    expect((await gate.approve(id, "djordje")).status).toBe("executed"); // case-insensitive, still an approver
  });

  it("AC-LOOP policy is re-checked at approval", async () => {
    const { call, gate, ledger } = await setup();
    const id = String((await call("propose_test", PROPOSAL)).json.action_id);
    tests.push(sum("Someone started one", "live", "AI edits limit reached"));
    const r = await gate.approve(id, "Djordje");
    expect(r).toMatchObject({ status: "blocked", policyRule: "live_test_on_placement" });
    expect(order).toEqual([]);
    expect(ledger.all().at(-1)).toMatchObject({ tool: "approve_create", status: "blocked" });
  });

  it("AC-LOOP create failure marks failed, no retry", async () => {
    createImpl = async () => {
      throw new AdaptyCliError("adapty ab-tests create failed (exit 1): boom", 1);
    };
    const { call, gate, ledger } = await setup();
    const id = String((await call("propose_test", PROPOSAL)).json.action_id);
    const r = await gate.approve(id, "Djordje");
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("boom");
    await gate.approve(id, "Djordje");
    expect(order).toEqual(["create"]);
    expect(ledger.all().map((e) => e.tool)).toEqual(["request_create", "approve_create", "execute_create"]);
    expect(ledger.all().at(-1)).toMatchObject({ status: "failed" });
  });

  it("AC-LOOP the daily write limit blocks a proposal", async () => {
    const { call, gate, ledger } = await setup();
    for (let n = 0; n < 5; n++) {
      ledger.append({ id: `e${n}`, ts: new Date().toISOString(), tool: "execute_stop", testId: "t", args: {}, verdict: "WINNER", status: "executed", reason: "stop executed" });
    }
    const r = await call("propose_test", PROPOSAL);
    expect(r.json).toMatchObject({ status: "blocked", policy_rule: "daily_write_limit" });
    expect(gate.pending()).toHaveLength(0);
  });

  it("AC-LOOP one ledger entry per request", async () => {
    const { call, ledger } = await setup();
    await call("propose_test", { ...PROPOSAL, challenger_weight: 80 }); // blocked
    await call("propose_test", PROPOSAL); // pending
    expect(ledger.all().map((e) => e.tool)).toEqual(["request_create", "request_create"]);
    expect(ledger.all().map((e) => e.status)).toEqual(["blocked", "pending"]);
  });

  it("AC-POLICY an invalid policy blocks every proposal with invalid_policy", async () => {
    policyState = { ok: false, reason: "maxChallengerWeight must be an integer from 1 to 99" };
    const { call, gate, ledger } = await setup();
    const r = await call("propose_test", PROPOSAL);
    expect(r.json).toMatchObject({ status: "blocked", policy_rule: "invalid_policy" });
    expect(String(r.json.reason)).toContain("maxChallengerWeight");
    expect(gate.pending()).toHaveLength(0);
    expect(ledger.all()).toHaveLength(1);
    expect(order).toEqual([]);
  });

  it("AC-LOOP the approval page approves a proposal through its own route, with the same CSRF and Origin checks", async () => {
    const { call, gate, stopGate } = await setup();
    const id = String((await call("propose_test", PROPOSAL)).json.action_id);
    const LOGIN = "l".repeat(64);
    const SECRET = "c".repeat(64);
    const app = buildApprovalApp(stopGate, undefined, { port: 8787, loginCode: LOGIN, csrfSecret: SECRET, proposals: gate });
    const host = { host: "127.0.0.1:8787" };
    const login = await app.request(`/login?t=${LOGIN}`, { headers: host });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const csrf = createHmac("sha256", SECRET).update(cookie.split("=")[1] ?? "").digest("hex");
    const post = (extra: Record<string, string>, csrfToken: string, name = "Djordje") =>
      app.request(`/proposals/${id}/approve`, {
        method: "POST",
        headers: { ...host, cookie, "content-type": "application/x-www-form-urlencoded", ...extra },
        body: new URLSearchParams({ csrf: csrfToken, name }).toString(),
      });
    expect((await post({}, csrf)).status).toBe(403); // no Origin
    expect((await post({ origin: "http://127.0.0.1:8787" }, "wrong")).status).toBe(403); // bad CSRF
    expect((await post({ origin: "http://127.0.0.1:8787" }, csrf, "mallory")).status).toBe(200); // refused, page with notice
    expect(order).toEqual([]);
    expect((await post({ origin: "http://127.0.0.1:8787" }, csrf)).status).toBe(303);
    expect(order).toEqual(["create"]);
  });

  it("AC-LOOP the approval page shows a create proposal, escaped", async () => {
    const { call, gate, stopGate } = await setup();
    await call("propose_test", { ...PROPOSAL, hypothesis: "<script>alert(1)</script> pay more" });
    const LOGIN = "l".repeat(64);
    const app = buildApprovalApp(stopGate, undefined, { port: 8787, loginCode: LOGIN, csrfSecret: "c".repeat(64), proposals: gate });
    const host = { host: "127.0.0.1:8787" };
    const login = await app.request(`/login?t=${LOGIN}`, { headers: host });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const html = await (await app.request("/", { headers: { ...host, cookie } })).text();
    expect(html).toContain("Proposed new tests");
    expect(html).toContain("ai_limit_reached");
    expect(html).toContain("AI limit reached - Pro");
    expect(html).toContain("50%");
    expect(html).toContain("starting it is your decision in Adapty");
    expect(html).toContain("/proposals/");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});

describe("ab-tests create arguments", () => {
  const approved = (audience: ApprovedCreate["audience"]): ApprovedCreate =>
    ({
      placementId: "pl-ai",
      flows: [{ flowId: "f1", weight: 50, title: "A" }, { flowId: "f2", weight: 50, title: "B" }],
      audience,
      title: "T",
      goal: "goal: rpi_60d",
    }) as ApprovedCreate;
  function cliWith(responses: string[]) {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return { stdout: responses.shift() ?? "{}", stderr: "", code: 0 };
    };
    return { cli: createAdaptyCli({ appId: "app", token: "tok", run }), calls };
  }

  it("create passes the verified flags and reads ab_test_id (flat or under data)", async () => {
    const flat = cliWith(['{"ab_test_id":"n1"}']);
    expect(await flat.cli.createTest(approved("all"))).toEqual({ abTestId: "n1" });
    expect(flat.calls[0]).toEqual([
      "ab-tests", "create", "--app", "app", "--title", "T", "--placement", "pl-ai",
      "--flows", '[{"flow_id":"f1","weight":50,"title":"A"},{"flow_id":"f2","weight":50,"title":"B"}]',
      "--goal", "goal: rpi_60d", "--all-users", "--json",
    ]);
    const nested = cliWith(['{"data":{"ab_test_id":"n2"}}']);
    expect(await nested.cli.createTest(approved({ segmentId: "s1" }))).toEqual({ abTestId: "n2" });
    expect(nested.calls[0]?.slice(-3)).toEqual(["--segment", "s1", "--json"]);
  });

  it("create fails closed when the response has no test id", async () => {
    const { cli } = cliWith(['{"ok":true}']);
    await expect(cli.createTest(approved("all"))).rejects.toThrow(/no ab_test_id/);
  });

  it("lists placements and flows tolerantly", async () => {
    const { cli } = cliWith([
      JSON.stringify({ data: [{ id: "p1", developer_id: "d1", title: "T1" }, { nope: 1 }] }),
      JSON.stringify({ data: [{ id: "f1", name: "N", status: "published" }, { id: 5 }] }),
    ]);
    expect(await cli.listPlacements()).toEqual([{ id: "p1", developerId: "d1", title: "T1" }]);
    expect(await cli.listFlows()).toEqual([{ id: "f1", name: "N", status: "published" }]);
  });
});

describe.skipIf(!real)("find_signals", () => {
  it("AC-LOOP find_signals shows 5+ edits paying about twice as often", async () => {
    const s = aiEditSignal(await loadDataset());
    const by = new Map(s.buckets.map((b) => [b.bucket, b]));
    expect(s.source).toBe("export_csv");
    expect(by.get("1-4")?.pay_rate).toBeGreaterThan(0.14);
    expect(by.get("1-4")?.pay_rate).toBeLessThan(0.17);
    expect(by.get("5+")?.pay_rate).toBeGreaterThan(0.29);
    expect(by.get("5+")?.pay_rate).toBeLessThan(0.33);
    expect(s.ratio_5plus_vs_1to4).toBeGreaterThan(1.8);
    expect(s.ratio_5plus_vs_1to4).toBeLessThan(2.2);
    expect(s.buckets.map((b) => b.n).every((n) => n > 1000)).toBe(true);
  });

  it("AC-LOOP find_signals tool returns the signal with a next step", async () => {
    const data = await loadDataset();
    const ledger = createLedger(join(dir, "l.jsonl"));
    const cli = { listTests: async () => tests, getTest: async (): Promise<AbTestDetail> => STARTED, stopTest: async (): Promise<AbTestDetail> => STARTED };
    const gate = createGate({ cli, ledger, judge: placeholderJudge });
    const server = buildServer({ cli, gate, judge: placeholderJudge, timeline: placeholderTimeline, signals: async () => ({ ...aiEditSignal(data) }) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: "find_signals", arguments: {} });
    const json = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Record<string, unknown>;
    expect(json.source).toBe("export_csv");
    expect(String(json.next_step)).toContain("consider propose_test");
  });
});
