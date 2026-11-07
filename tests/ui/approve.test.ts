import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbTestDetail, ApprovedStop } from "../../src/adapty/types.js";
import { createLedger } from "../../src/gate/ledger.js";
import { createGate, type Judge } from "../../src/gate/pending.js";
import { buildApprovalApp, startApprovalPage } from "../../src/ui/approve.js";

const DETAIL: AbTestDetail = {
  abTestId: "t1",
  title: "T",
  state: "completed",
  placementTitle: "P",
  arms: [{ armId: "a1", name: "A" }],
};
const winner: Judge = async () => ({ verdict: "WINNER", winnerArmId: "a1", reasons: ["clear win"] });
const REQ = { testId: "t1", winnerArmId: "a1", metric: "arpu", rationale: "ship it" };
const PORT = 8787;
const GOOD = `http://127.0.0.1:${PORT}`;

let dir: string;
let calls: ApprovedStop[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fulcrum-ui-"));
  calls = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(judge: Judge = winner) {
  const ledger = createLedger(join(dir, "ledger.jsonl"));
  const cli = {
    stopTest: async (a: ApprovedStop) => {
      calls.push(a);
      return DETAIL;
    },
  };
  const gate = createGate({ cli, ledger, judge });
  const app = buildApprovalApp(gate, ledger, PORT);
  return { gate, ledger, app };
}

const form = (name: string) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: GOOD },
  body: new URLSearchParams({ name }).toString(),
});

describe("approval page", () => {
  it("GET / lists a pending action", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    const html = await (await app.request("/")).text();
    expect(html).toContain(actionId);
    expect(html).toContain("t1");
    expect(html).toContain("arpu");
    expect(html).toContain("WINNER");
    expect(html).toContain("clear win");
    expect(html).toContain(`/approve/${actionId}`);
    expect(html).toContain(`/reject/${actionId}`);
    expect(html).not.toContain("<script");
  });

  it("approve with a name executes once and redirects", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    const res = await app.request(`/approve/${actionId}`, form("djole"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(calls).toHaveLength(1);
    await app.request(`/approve/${actionId}`, form("djole"));
    expect(calls).toHaveLength(1);
  });

  it("approve with an empty or blank name is 400 and makes no CLI call", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    expect((await app.request(`/approve/${actionId}`, form(""))).status).toBe(400);
    expect((await app.request(`/approve/${actionId}`, form("   "))).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(gate.status(actionId).status).toBe("pending");
  });

  it("a foreign Origin is 403 and makes no CLI call", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    for (const origin of ["https://evil.example", "null", `http://127.0.0.1:${PORT + 1}`, `http://localhost:${PORT}.evil.com`]) {
      const init = form("djole");
      const res = await app.request(`/approve/${actionId}`, { ...init, headers: { ...init.headers, origin } });
      expect(res.status).toBe(403);
    }
    const rej = form("djole");
    expect((await app.request(`/reject/${actionId}`, { ...rej, headers: { ...rej.headers, origin: "https://evil.example" } })).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(gate.status(actionId).status).toBe("pending");
  });

  it("localhost origin and a missing Origin are accepted", async () => {
    const { gate, app } = setup();
    const a = await gate.requestStop(REQ);
    const init = form("djole");
    const res = await app.request(`/approve/${a.actionId}`, { ...init, headers: { ...init.headers, origin: `http://localhost:${PORT}` } });
    expect(res.status).toBe(303);
    const { gate: g2, app: app2 } = setup();
    const b = await g2.requestStop(REQ);
    const noOrigin = await app2.request(`/reject/${b.actionId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=djole",
    });
    expect(noOrigin.status).toBe(303);
    expect(g2.status(b.actionId).status).toBe("rejected");
  });

  it("reject never calls the CLI; unknown id is 404", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    expect((await app.request(`/reject/${actionId}`, form("djole"))).status).toBe(303);
    expect(calls).toHaveLength(0);
    expect((await app.request("/approve/nope", form("djole"))).status).toBe(404);
    expect((await app.request("/reject/nope", form("djole"))).status).toBe(404);
  });

  it("a gate refusal shows its reason instead of crashing", async () => {
    let n = 0;
    const flip: Judge = async () =>
      n++ === 0
        ? { verdict: "WINNER", winnerArmId: "a1", reasons: ["ok"] }
        : { verdict: "CONTINUE", reasons: ["data moved <b>"] };
    const { gate, app } = setup(flip);
    const { actionId } = await gate.requestStop(REQ);
    const res = await app.request(`/approve/${actionId}`, form("djole"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("re-judge at approval did not confirm");
    expect(html).toContain("&lt;b&gt;");
    expect(calls).toHaveLength(0);
  });

  it("escapes agent-supplied values", async () => {
    const evil: Judge = async () => ({
      verdict: "WINNER",
      winnerArmId: "a1",
      reasons: ["<script>alert(1)</script>"],
    });
    const { gate, app, ledger } = setup(evil);
    await gate.requestStop({ ...REQ, testId: "t<img src=x>", rationale: "<script>alert(2)</script>" });
    const html = await (await app.request("/")).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const l = await (await app.request("/ledger")).text();
    expect(l).not.toContain("<script>alert");
    expect(l).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(ledger.all().length).toBeGreaterThan(0);
  });

  it("GET /ledger shows only the last 20 entries and is read-only", async () => {
    const { ledger, app } = setup();
    for (let i = 0; i < 25; i++) {
      ledger.append({ id: `id-${i}`, ts: "2026-11-07T00:00:00Z", tool: "request_stop", testId: "t", args: {}, verdict: "X", status: "blocked", reason: "r" });
    }
    const html = await (await app.request("/ledger")).text();
    expect(html).toContain("id-24");
    expect(html).toContain("id-5");
    expect(html).not.toContain("id-4<");
    expect(html).not.toContain(">id-4 ");
    expect(html).not.toContain("<form");
    expect((await app.request("/ledger", { method: "POST", headers: { origin: GOOD } })).status).toBe(404);
  });
});

describe("startApprovalPage", () => {
  it("binds 127.0.0.1 only", async () => {
    vi.resetModules();
    const serve = vi.fn((_opts: unknown) => ({}));
    vi.doMock("@hono/node-server", () => ({ serve }));
    const mod = await import("../../src/ui/approve.js");
    const { gate } = setup();
    mod.startApprovalPage(gate, 9999);
    expect(serve).toHaveBeenCalledTimes(1);
    const opts = serve.mock.calls[0]?.[0] as { hostname: string; port: number };
    expect(opts.hostname).toBe("127.0.0.1");
    expect(opts.port).toBe(9999);
    vi.doUnmock("@hono/node-server");
    expect(typeof startApprovalPage).toBe("function");
  });
});
