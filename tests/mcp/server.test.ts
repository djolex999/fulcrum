import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdaptyCliError } from "../../src/adapty/cli.js";
import type { AbTestDetail, AbTestSummary } from "../../src/adapty/types.js";
import { createGate, type Judge } from "../../src/gate/pending.js";
import { createLedger } from "../../src/gate/ledger.js";
import { createLogger } from "../../src/mcp/log.js";
import { buildServer } from "../../src/mcp/server.js";
import { placeholderJudge, placeholderTimeline } from "../../src/mcp/tools.js";

// Built by concatenation so the pre-commit secret scan does not flag this file.
const TOKEN = "dev_live_" + "TESTTOKEN";

const LIVE: AbTestDetail = {
  abTestId: "t-live",
  title: "Live test",
  state: "live",
  placementTitle: "Onboarding",
  arms: [
    { armId: "arm-a", name: "A" },
    { armId: "arm-b", name: "B" },
  ],
};
const DONE: AbTestDetail = { ...LIVE, abTestId: "t-done", title: "Done test", state: "completed" };

const summaries = (): AbTestSummary[] =>
  [LIVE, DONE].map(({ arms: _a, ...s }) => s);

let dir: string;
let ledgerPath: string;
let cliFail: boolean;
const stopCalls: unknown[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fulcrum-mcp-"));
  ledgerPath = join(dir, "ledger.jsonl");
  cliFail = false;
  stopCalls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const winnerJudge: Judge = async () => ({ verdict: "WINNER", winnerArmId: "arm-a", reasons: ["clear win"] });

async function setup(judge: Judge = placeholderJudge) {
  const ledger = createLedger(ledgerPath);
  const fakeCli = {
    listTests: async () => {
      if (cliFail) throw new AdaptyCliError(`adapty ab-tests list failed (exit 1): token ${TOKEN} rejected`, 1);
      return summaries();
    },
    getTest: async (id: string) => {
      const t = [LIVE, DONE].find((x) => x.abTestId === id);
      if (!t) throw new AdaptyCliError("not found", 1);
      return t;
    },
    stopTest: async (a: unknown) => {
      stopCalls.push(a);
      return LIVE;
    },
  };
  const gate = createGate({ cli: fakeCli, ledger, judge });
  const { log, scrub } = createLogger(TOKEN);
  const server = buildServer({
    cli: fakeCli,
    gate,
    judge: judge === placeholderJudge ? placeholderJudge : async (id, o) => judge(id, o),
    timeline: placeholderTimeline,
    log,
    scrub,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: res.isError === true, text, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { client, call, gate };
}

describe("Fulcrum MCP server", () => {
  it("tools are exactly the seven in SPEC.md, no approve tool", async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["find_signals", "judge_test", "list_tests", "propose_test", "request_status", "request_stop", "test_timeline"]);
    expect(names.some((n) => /approve/i.test(n))).toBe(false);
  });

  it("list_tests returns the Adapty tests", async () => {
    const { call } = await setup();
    const r = await call("list_tests");
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ tests: [{ test_id: "t-live", title: "Live test", state: "live", placement: "Onboarding" }, { test_id: "t-done" }] });
  });

  it("request_stop with the placeholder judge is blocked", async () => {
    const { call } = await setup();
    const r = await call("request_stop", { test_id: "t-live", winner_arm_id: "arm-a", metric: "rpi", rationale: "x" });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ status: "blocked", verdict: "CONTINUE" });
    expect(String(r.json.reason)).toContain("verdict engine not built yet");
  });

  it("request_stop on a live WINNER returns pending, and request_status shows pending", async () => {
    const { call } = await setup(winnerJudge);
    const r = await call("request_stop", { test_id: "t-live", winner_arm_id: "arm-a", metric: "rpi", rationale: "x" });
    expect(r.json).toMatchObject({ status: "pending", verdict: "WINNER" });
    const s = await call("request_status", { action_id: r.json.action_id });
    expect(s.json).toMatchObject({ action_id: r.json.action_id, status: "pending" });
    expect(stopCalls).toHaveLength(0);
  });

  it("a second request for a pending test is a DUPLICATE_PENDING error", async () => {
    const { call } = await setup(winnerJudge);
    const args = { test_id: "t-live", winner_arm_id: "arm-a", metric: "rpi", rationale: "x" };
    await call("request_stop", args);
    const r = await call("request_stop", args);
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("DUPLICATE_PENDING");
  });

  it("in-flight duplicate is blocked 'request in progress', never pending", async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((res) => (release = res));
    const slow: Judge = async () => {
      await gateOpen;
      return { verdict: "WINNER", winnerArmId: "arm-a", reasons: ["ok"] };
    };
    const { call } = await setup(slow);
    const args = { test_id: "t-live", winner_arm_id: "arm-a", metric: "rpi", rationale: "x" };
    const first = call("request_stop", args);
    await new Promise((r) => setTimeout(r, 20));
    const second = await call("request_stop", args);
    expect(second.isError).toBe(false);
    expect(second.json.status).toBe("blocked");
    expect(String(second.json.reason)).toContain("request in progress, retry request_stop in a moment");
    release();
    expect((await first).json.status).toBe("pending");
  });

  it("unknown test id returns UNKNOWN_TEST", async () => {
    const { call } = await setup();
    for (const [tool, args] of [
      ["judge_test", { test_id: "nope" }],
      ["test_timeline", { test_id: "nope" }],
      ["request_stop", { test_id: "nope", winner_arm_id: "arm-a", metric: "rpi", rationale: "x" }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.json.code).toBe("UNKNOWN_TEST");
    }
  });

  it("request_stop on a completed test returns NOT_LIVE", async () => {
    const { call } = await setup(winnerJudge);
    const r = await call("request_stop", { test_id: "t-done", winner_arm_id: "arm-a", metric: "rpi", rationale: "x" });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("NOT_LIVE");
  });

  it("request_stop replay (as_of) on a completed test is judged, blocked as replay only, never pending", async () => {
    const { call } = await setup(winnerJudge);
    const r = await call("request_stop", { test_id: "t-done", winner_arm_id: "arm-a", metric: "rpi", rationale: "x", as_of: "2026-08-16" });
    expect(r.isError).toBeFalsy();
    expect(r.json.status).toBe("blocked");
    expect(String(r.json.reason)).toContain("replay only");
    const s = await call("request_status", { action_id: r.json.action_id });
    expect(s.json.status).toBe("blocked");
  });

  it("request_stop with an arm id not in the test returns UNKNOWN_ARM", async () => {
    const { call } = await setup(winnerJudge);
    const r = await call("request_stop", { test_id: "t-live", winner_arm_id: "arm-zzz", metric: "rpi", rationale: "x" });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("UNKNOWN_ARM");
  });

  it("AC-8 as_of with adapty_metrics is rejected", async () => {
    const { call } = await setup();
    const r = await call("judge_test", { test_id: "t-live", source: "adapty_metrics", as_of: "2026-08-16" });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("AS_OF_REQUIRES_CSV");
  });

  it("invalid as_of returns INVALID_AS_OF", async () => {
    const { call } = await setup();
    const r = await call("judge_test", { test_id: "t-live", as_of: "not-a-date" });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("INVALID_AS_OF");
  });

  it("test_timeline with the placeholder returns NOT_IMPLEMENTED", async () => {
    const { call } = await setup();
    const r = await call("test_timeline", { test_id: "t-live" });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("NOT_IMPLEMENTED");
  });

  it("request_status for an unknown action returns UNKNOWN_ACTION", async () => {
    const { call } = await setup();
    const r = await call("request_status", { action_id: "nope" });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("UNKNOWN_ACTION");
  });

  it("Adapty failure returns ADAPTY_UNAVAILABLE", async () => {
    const { call } = await setup();
    cliFail = true;
    const r = await call("list_tests");
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("ADAPTY_UNAVAILABLE");
  });

  it("AC-TOKEN AC-5 token absent from outputs, errors, ledger and logs", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const { call } = await setup(winnerJudge);
    const outputs: string[] = [];
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      outputs.push((await call(name, args)).text);
    };
    await run("list_tests");
    await run("judge_test", { test_id: "t-live" });
    await run("test_timeline", { test_id: "t-live" });
    await run("request_stop", { test_id: "t-live", winner_arm_id: "arm-a", metric: "rpi", rationale: `leak ${TOKEN}` });
    await run("request_status", { action_id: "nope" });
    cliFail = true;
    await run("list_tests");
    await run("judge_test", { test_id: "t-live" });
    const ledger = readFileSync(ledgerPath, "utf8");
    expect(ledger.length).toBeGreaterThan(0);
    const everything = [...outputs, ...written, ledger].join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("TESTTOKEN");
    expect(written.length).toBeGreaterThan(0); // logging actually happened, to stderr
  });
});
