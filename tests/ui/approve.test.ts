import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbTestDetail, ApprovedStop } from "../../src/adapty/types.js";
import { createLedger } from "../../src/gate/ledger.js";
import { createGate, type Judge } from "../../src/gate/pending.js";
import { buildApprovalApp } from "../../src/ui/approve.js";

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
const HOST = `127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const CSRF = "c".repeat(64);
const COOKIE = `fulcrum_session=${SESSION}`;

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
  const app = buildApprovalApp(gate, ledger, { port: PORT, sessionSecret: SESSION, csrfSecret: CSRF });
  return { gate, ledger, app };
}

interface Opts {
  cookie?: string | null;
  csrf?: string | null;
  origin?: string | null;
  host?: string;
}
function post(name: string, o: Opts = {}) {
  const params = new URLSearchParams({ name });
  const csrf = o.csrf === undefined ? CSRF : o.csrf;
  if (csrf !== null) params.set("csrf", csrf);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host: o.host ?? HOST,
  };
  const origin = o.origin === undefined ? GOOD : o.origin;
  if (origin !== null) headers["origin"] = origin;
  const cookie = o.cookie === undefined ? COOKIE : o.cookie;
  if (cookie !== null) headers["cookie"] = cookie;
  return { method: "POST", headers, body: params.toString() };
}
const get = (o: Opts = {}) => {
  const headers: Record<string, string> = { host: o.host ?? HOST };
  const cookie = o.cookie === undefined ? COOKIE : o.cookie;
  if (cookie !== null) headers["cookie"] = cookie;
  return { headers };
};

describe("approval page", () => {
  it("GET / lists a pending action with csrf field and rationale", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    const html = await (await app.request("/", get())).text();
    for (const s of [actionId, "t1", "arpu", "WINNER", "clear win", `/approve/${actionId}`, `/reject/${actionId}`]) {
      expect(html).toContain(s);
    }
    expect(html).toContain(`name="csrf" value="${CSRF}"`);
    expect(html).not.toContain("<script");
  });

  it("the rationale is shown escaped on the page", async () => {
    const { gate, app } = setup();
    await gate.requestStop({ ...REQ, rationale: "<b>because</b> ship it" });
    const html = await (await app.request("/", get())).text();
    expect(html).toContain("&lt;b&gt;because&lt;/b&gt; ship it");
    expect(html).not.toContain("<b>because");
  });

  it("approve with a name executes once and redirects", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    const res = await app.request(`/approve/${actionId}`, post("djole"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(calls).toHaveLength(1);
    await app.request(`/approve/${actionId}`, post("djole"));
    expect(calls).toHaveLength(1);
  });

  it("approve with an empty or blank name is 400 and makes no CLI call", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    expect((await app.request(`/approve/${actionId}`, post(""))).status).toBe(400);
    expect((await app.request(`/approve/${actionId}`, post("   "))).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(gate.status(actionId).status).toBe("pending");
  });

  it("AC-4 POST approve without session cookie is 401 and runs no stop", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    expect((await app.request(`/approve/${actionId}`, post("djole", { cookie: null }))).status).toBe(401);
    expect((await app.request(`/approve/${actionId}`, post("djole", { cookie: "fulcrum_session=wrong" }))).status).toBe(401);
    expect((await app.request(`/reject/${actionId}`, post("djole", { cookie: null }))).status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(gate.status(actionId).status).toBe("pending");
  });

  it("POST approve with cookie but wrong or missing csrf is 403 and runs no stop", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    expect((await app.request(`/approve/${actionId}`, post("djole", { csrf: null }))).status).toBe(403);
    expect((await app.request(`/approve/${actionId}`, post("djole", { csrf: "x".repeat(64) }))).status).toBe(403);
    expect((await app.request(`/reject/${actionId}`, post("djole", { csrf: "" }))).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(gate.status(actionId).status).toBe("pending");
  });

  it("POST approve with no Origin header is 403", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    expect((await app.request(`/approve/${actionId}`, post("djole", { origin: null }))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("a foreign Origin is 403 and makes no CLI call", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    for (const origin of ["https://evil.example", "null", `http://127.0.0.1:${PORT + 1}`, `http://localhost:${PORT}.evil.com`]) {
      expect((await app.request(`/approve/${actionId}`, post("djole", { origin }))).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("localhost origin and host are accepted", async () => {
    const { gate, app } = setup();
    const { actionId } = await gate.requestStop(REQ);
    const res = await app.request(
      `/reject/${actionId}`,
      post("djole", { origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` }),
    );
    expect(res.status).toBe(303);
    expect(gate.status(actionId).status).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("unknown id is 404", async () => {
    const { app } = setup();
    expect((await app.request("/approve/nope", post("djole"))).status).toBe(404);
    expect((await app.request("/reject/nope", post("djole"))).status).toBe(404);
  });

  it("GET / without cookie is 401, GET /ledger too", async () => {
    const { app } = setup();
    const res = await app.request("/", get({ cookie: null }));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Open the link Fulcrum opened in your browser");
    expect((await app.request("/ledger", get({ cookie: null }))).status).toBe(401);
  });

  it("GET /login with wrong t is 401", async () => {
    const { app } = setup();
    expect((await app.request("/login?t=nope", get({ cookie: null }))).status).toBe(401);
    expect((await app.request("/login", get({ cookie: null }))).status).toBe(401);
  });

  it("GET /login with right t sets HttpOnly SameSite=Strict cookie", async () => {
    const { app } = setup();
    const res = await app.request(`/login?t=${SESSION}`, get({ cookie: null }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`fulcrum_session=${SESSION}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toContain("Path=/");
  });

  it("wrong Host is rejected", async () => {
    const { app } = setup();
    for (const host of ["evil.example", `127.0.0.1:${PORT + 1}`, `localhost`]) {
      expect((await app.request("/", get({ host }))).status).toBe(421);
      expect((await app.request(`/login?t=${SESSION}`, get({ host, cookie: null }))).status).toBe(421);
    }
  });

  it("frame headers present", async () => {
    const { app } = setup();
    for (const res of [
      await app.request("/", get()),
      await app.request("/", get({ cookie: null })),
      await app.request(`/login?t=${SESSION}`, get({ cookie: null })),
    ]) {
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    }
  });

  it("a gate refusal shows its reason instead of crashing", async () => {
    let n = 0;
    const flip: Judge = async () =>
      n++ === 0
        ? { verdict: "WINNER", winnerArmId: "a1", reasons: ["ok"] }
        : { verdict: "CONTINUE", reasons: ["data moved <b>"] };
    const { gate, app } = setup(flip);
    const { actionId } = await gate.requestStop(REQ);
    const res = await app.request(`/approve/${actionId}`, post("djole"));
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
    const { gate, app } = setup(evil);
    await gate.requestStop({ ...REQ, testId: "t<img src=x>", rationale: "<script>alert(2)</script>" });
    const html = await (await app.request("/", get())).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const l = await (await app.request("/ledger", get())).text();
    expect(l).not.toContain("<script>alert");
    expect(l).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("GET /ledger shows only the last 20 entries and is read-only", async () => {
    const { ledger, app } = setup();
    for (let i = 0; i < 25; i++) {
      ledger.append({ id: `id-${i}`, ts: "2026-11-07T00:00:00Z", tool: "request_stop", testId: "t", args: {}, verdict: "X", status: "blocked", reason: "r" });
    }
    const html = await (await app.request("/ledger", get())).text();
    expect(html).toContain("id-24");
    expect(html).toContain("id-5<");
    expect(html).not.toContain("id-4<");
    expect(html).not.toContain("<form");
    expect((await app.request("/ledger", { ...post("x") })).status).toBe(404);
  });
});

describe("startApprovalPage", () => {
  async function start(env: Record<string, string | undefined> = {}) {
    vi.resetModules();
    const handlers: Record<string, (e: Error) => void> = {};
    const serve = vi.fn((_opts: unknown) => ({
      on: (ev: string, fn: (e: Error) => void) => {
        handlers[ev] = fn;
      },
    }));
    vi.doMock("@hono/node-server", () => ({ serve }));
    const prev = process.env.FULCRUM_NO_BROWSER;
    if ("FULCRUM_NO_BROWSER" in env) {
      if (env.FULCRUM_NO_BROWSER === undefined) delete process.env.FULCRUM_NO_BROWSER;
      else process.env.FULCRUM_NO_BROWSER = env.FULCRUM_NO_BROWSER;
    }
    const mod = await import("../../src/ui/approve.js");
    const { gate, ledger } = setup();
    const logs: string[] = [];
    const urls: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mod.startApprovalPage(gate, 9999, ledger, (m) => logs.push(m), (u) => urls.push(u));
    const written = [...stderr.mock.calls, ...stdout.mock.calls].map((c) => String(c[0]));
    stderr.mockRestore();
    stdout.mockRestore();
    if (prev === undefined) delete process.env.FULCRUM_NO_BROWSER;
    else process.env.FULCRUM_NO_BROWSER = prev;
    vi.doUnmock("@hono/node-server");
    return { serve, handlers, logs, urls, written, gate };
  }

  it("binds 127.0.0.1 only", async () => {
    const { serve } = await start({ FULCRUM_NO_BROWSER: "1" });
    expect(serve).toHaveBeenCalledTimes(1);
    const opts = serve.mock.calls[0]?.[0] as { hostname: string; port: number };
    expect(opts.hostname).toBe("127.0.0.1");
    expect(opts.port).toBe(9999);
  });

  it("opens the login url with the session secret; FULCRUM_NO_BROWSER=1 skips it", async () => {
    const r = await start({ FULCRUM_NO_BROWSER: undefined });
    expect(r.urls).toHaveLength(1);
    expect(r.urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:9999\/login\?t=[0-9a-f]{64}$/);
    const skipped = await start({ FULCRUM_NO_BROWSER: "1" });
    expect(skipped.urls).toHaveLength(0);
  });

  it("secrets never logged", async () => {
    const r = await start({ FULCRUM_NO_BROWSER: undefined });
    const secret = /t=([0-9a-f]{64})/.exec(r.urls[0] ?? "")?.[1] ?? "";
    expect(secret).toHaveLength(64);
    expect([...r.logs, ...r.written].join("\n")).not.toContain(secret);
  });

  it("a serve error is logged and does not throw", async () => {
    const r = await start({ FULCRUM_NO_BROWSER: "1" });
    expect(() => r.handlers["error"]?.(new Error("listen EADDRINUSE"))).not.toThrow();
    expect(r.logs.join("\n")).toContain("EADDRINUSE");
  });
});
