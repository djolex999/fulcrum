// The human approval page (localhost only). The security goal: only the human, in their own browser,
// can approve. The agent, even with shell access and curl, must not be able to.
// Layers: bound to 127.0.0.1; Host check; a one-time login link that only the opened browser gets;
// a cookie; a CSRF token on every button; an Origin check on every POST.

import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Ledger } from "../gate/ledger.js";
import type { ActionView, createGate } from "../gate/pending.js";
import { DRAFT_NOTE, type ProposalView, type Proposals } from "../gate/proposals.js";
import { createLogger } from "../mcp/log.js";
import type { StopLabels } from "./labels.js";

type Gate = ReturnType<typeof createGate>;

const LEDGER_LIMIT = 20;

// Everything shown on this page can come from the agent (rationale, reasons). Escape it all, or an agent could inject a fake Approve button.
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

// One stylesheet, no scripts. Cards instead of a wide table, so a human sees in two seconds WHAT they approve.
const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#14161a;--muted:#5d6470;--line:#e3e6eb;--soft:#f1f3f6;
--stop:#b42318;--stop-bg:#fdecea;--new:#1d4ed8;--new-bg:#e8efff;--ok:#067647;--ok-bg:#e6f6ee;--warn:#8a5a00;--warn-bg:#fff6dd}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--ink:#eceff3;--muted:#9aa3af;--line:#2a2f38;--soft:#1f232b;
--stop:#ff8a7a;--stop-bg:#3a1d1a;--new:#8fb0ff;--new-bg:#1c2540;--ok:#2f9e6a;--ok-bg:#15301f;--warn:#f2c66d;--warn-bg:#352a12}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:56rem;margin:0 auto;padding:2rem 1rem 3rem}
header.top{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
h1{font-size:1.6rem;margin:0}
.tag{color:var(--muted);margin:.25rem 0 0}
h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:2rem 0 .75rem}
.count{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:.3rem .8rem;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:1rem;overflow:hidden}
.card.stop{border-top:4px solid var(--stop)}.card.new{border-top:4px solid var(--new)}
.head{padding:1rem 1.25rem .5rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.badge{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:6px;padding:.2rem .5rem}
.b-stop{background:var(--stop-bg);color:var(--stop)}.b-new{background:var(--new-bg);color:var(--new)}
.b-ok{background:var(--ok-bg);color:var(--ok)}.b-muted{background:var(--soft);color:var(--muted)}
.body{padding:0 1.25rem 1rem}
.title{font-size:1.25rem;font-weight:700;margin:.1rem 0 0}
.id{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);word-break:break-all}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.75rem;margin:1rem 0}
.box{background:var(--soft);border-radius:10px;padding:.75rem .9rem}
.label{font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:.2rem}
.big{font-size:1.05rem;font-weight:650}
.why{border-left:3px solid var(--ok);padding:.25rem 0 .25rem .8rem;margin:.75rem 0}
.agent{border-left:3px solid var(--line);padding:.25rem 0 .25rem .8rem;margin:.75rem 0;color:var(--muted)}
.agent .said{color:var(--ink);font-style:italic}
ul.policy{margin:.25rem 0 0;padding-left:1.1rem}
.callout{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:.6rem .9rem;margin:.75rem 0;font-weight:600}
.decide{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line);background:var(--soft);padding:.9rem 1.25rem;margin:0}
.decide input[name=name]{flex:1 1 12rem;min-width:10rem;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
button{font:inherit;font-weight:650;border-radius:8px;padding:.55rem 1.1rem;cursor:pointer;border:1px solid transparent}
.approve{background:var(--ok);color:#fff}.reject{background:transparent;color:var(--stop);border-color:var(--stop)}
.when{color:var(--muted);font-size:.85rem;margin-left:auto}
.notice{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:.7rem 1rem;font-weight:600}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:14px;padding:2.5rem;text-align:center;color:var(--muted)}
table{border-collapse:collapse;width:100%;background:var(--card);font-size:.85rem}
td,th{border:1px solid var(--line);padding:.4rem .5rem;text-align:left;vertical-align:top}
a{color:var(--new)}
`;

// Constant-time comparison for secrets, so response timing can't leak a correct guess character by character.
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface ApprovalSecrets {
  /** Single-use, short-lived code carried in the login URL. Never the cookie value. */
  loginCode: string;
  csrfSecret: string;
}

// The login link is valid once, for FULCRUM_LOGIN_TTL seconds (integer 10-3600, default 60). If you miss it, restart Fulcrum for a new one.
const DEFAULT_LOGIN_TTL_S = 60;

/** Login-link lifetime in ms from FULCRUM_LOGIN_TTL (seconds). Missing or invalid gives 60 s. */
export function loginTtlMs(raw: string | undefined = process.env.FULCRUM_LOGIN_TTL): number {
  const n = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return (Number.isInteger(n) && n >= 10 && n <= 3600 ? n : DEFAULT_LOGIN_TTL_S) * 1000;
}

const SESSION_COOKIE = "fulcrum_session";

// The decision bar shared by both card kinds. The name is required and recorded in the ledger as the approver.
function decideForm(csrf: string, approveAction: string, rejectAction: string, approveLabel: string, createdAt: string): string {
  return `<form class="decide" method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input name="name" placeholder="your name (recorded in the ledger)" required aria-label="your name">
<button class="approve" type="submit" formaction="${approveAction}">${escapeHtml(approveLabel)}</button>
<button class="reject" type="submit" formaction="${rejectAction}">Reject</button>
<span class="when" title="${escapeHtml(createdAt)}">requested ${escapeHtml(shortTime(createdAt))}</span></form>`;
}

// "2026-11-07T20:06:40.540Z" -> "20:06 UTC"; anything else is shown as is.
function shortTime(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} UTC` : iso;
}

// A stop request: names first (what a human checks), ids underneath (what Fulcrum acts on).
function pendingRow(a: ActionView, csrf: string, labels?: StopLabels): string {
  const id = encodeURIComponent(a.actionId);
  const l = labels?.get(a.actionId);
  const testName = l ? escapeHtml(l.testTitle) : "A/B test";
  const armName = l && l.armName ? escapeHtml(l.armName) : escapeHtml(a.winnerArmId);
  return `<article class="card stop">
<div class="head"><span class="badge b-stop">Stop a test</span><span class="badge b-ok">Verdict: ${escapeHtml(a.verdict)}</span><span class="badge b-muted">Metric: ${escapeHtml(a.metric)}</span></div>
<div class="body">
<p class="title">${testName}</p><div class="id">test ${escapeHtml(a.testId)} · request ${escapeHtml(a.actionId)}</div>
<div class="grid"><div class="box"><div class="label">Ship this winner</div><div class="big">${armName}</div><div class="id">${escapeHtml(a.winnerArmId)}</div></div>
<div class="box"><div class="label">What happens on Approve</div>Fulcrum re-checks the verdict, then stops the test in Adapty with this winner. A stopped test cannot be restarted.</div></div>
<div class="why"><div class="label">Fulcrum's check</div>${escapeHtml(a.reason)}</div>
<div class="agent"><div class="label">The agent's words (not verified)</div><span class="said">${escapeHtml(a.rationale)}</span></div>
</div>
${decideForm(csrf, `/approve/${id}`, `/reject/${id}`, "Approve: stop the test", a.createdAt)}
</article>`;
}

// A proposed NEW test. Approving only creates it as a draft; starting it is a human decision in Adapty.
function proposalRow(a: ProposalView, csrf: string): string {
  const id = encodeURIComponent(a.actionId);
  const flows = a.flows
    .map(
      (f, i) =>
        `<div class="box"><div class="label">${i === 0 ? "Control" : "Challenger"} · ${escapeHtml(f.weight)}% of traffic</div><div class="big">${escapeHtml(f.flowName)}</div><div class="id">${escapeHtml(f.flowId)}</div></div>`,
    )
    .join("");
  // The pending reason is the policy notes followed by the draft note; the draft note has its own callout below.
  const notes = a.reason.replace(DRAFT_NOTE, "").replace(/[;\s]+$/, "").trim();
  const policy = `<li>Passed: allowed placement, traffic cap, no live test on this placement, daily write limit.</li>${notes ? `<li>${escapeHtml(notes)}</li>` : ""}`;
  const audience = a.audience === "all" ? "All users" : `Segment ${escapeHtml(a.audience)}`;
  return `<article class="card new">
<div class="head"><span class="badge b-new">New test · draft only</span><span class="badge b-ok">Policy check passed</span><span class="badge b-muted">Audience: ${audience}</span></div>
<div class="body">
<p class="title">${escapeHtml(a.placementTitle)}</p><div class="id">placement ${escapeHtml(a.placement)} · request ${escapeHtml(a.actionId)}</div>
<div class="grid">${flows}</div>
<div class="agent"><div class="label">The agent's hypothesis (not verified)</div><span class="said">${escapeHtml(a.hypothesis)}</span></div>
<div class="why"><div class="label">Policy (fulcrum.policy.json)</div><ul class="policy">${policy}</ul></div>
<div class="callout">Approving creates the test as a draft only; starting it is your decision in Adapty.</div>
</div>
${decideForm(csrf, `/proposals/${id}/approve`, `/proposals/${id}/reject`, "Approve: create draft", a.createdAt)}
</article>`;
}

function listPage(gate: Gate, csrf: string, notice?: string, proposals?: Proposals, labels?: StopLabels): string {
  const stops = gate.pending();
  const props = proposals?.pending() ?? [];
  const n = stops.length + props.length;
  const note = notice ? `<p class="notice">${escapeHtml(notice)}</p>` : "";
  const stopSection = stops.length ? `<h2>Stop a test</h2>${stops.map((a) => pendingRow(a, csrf, labels)).join("")}` : "";
  const propSection = props.length ? `<h2>Proposed new tests</h2>${props.map((a) => proposalRow(a, csrf)).join("")}` : "";
  const body =
    stopSection + propSection ||
    `<div class="empty">No pending actions. When an agent asks Fulcrum for a change that passes its checks, it appears here for you to decide.</div>`;
  const top = `<header class="top"><div><h1>Fulcrum approvals</h1><p class="tag">Agents ask. You decide. Nothing changes in Adapty until you approve.</p></div><span class="count">${n} waiting</span></header>`;
  return page("Fulcrum approvals", `${top}${note}${body}<p><a href="/ledger">Ledger: every attempt, blocked or approved</a></p>`);
}

// Request path, in order: security headers -> Host check -> /login (one-time code, sets cookie)
// -> everything else needs a valid session cookie -> POSTs also need the right Origin and a CSRF token.
export function buildApprovalApp(
  gate: Gate,
  ledger: Ledger | undefined,
  opts: ApprovalSecrets & { port?: number; now?: () => number; proposals?: Proposals; loginTtlMs?: number; labels?: StopLabels },
): Hono {
  const port = opts.port ?? 8787;
  const { csrfSecret, proposals, labels } = opts;
  const now = opts.now ?? (() => Date.now());
  // The login code exists only in this process's memory and in the URL that Fulcrum opens in the user's browser. The agent never sees it.
  let loginCode: string | null = opts.loginCode;
  const loginExpiresAt = now() + (opts.loginTtlMs ?? loginTtlMs());
  const sessions = new Set<string>();
  // CSRF token derived from the session id + a server secret. A page on another site can't guess it, so it can't submit the form for you.
  const csrfFor = (sessionId: string): string => createHmac("sha256", csrfSecret).update(sessionId).digest("hex");
  const sessionOf = (c: Context): string => getCookie(c, SESSION_COOKIE) ?? "";
  const { scrub } = createLogger("");
  const app = new Hono();
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
  });

  // Only accept Host: 127.0.0.1:<port> or localhost:<port>. Stops a malicious site from re-pointing its own domain at localhost and talking to us.
  // DNS-rebinding guard.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host === undefined || !allowedHosts.has(host)) return c.text("forbidden host", 421);
    await next();
  });

  app.get("/login", (c) => {
    const t = c.req.query("t");
    if (t === undefined) return c.text("Restart Fulcrum to get a new login link.", 401);
    if (loginCode === null || now() > loginExpiresAt || !safeEqual(t, loginCode)) {
      return c.text("invalid or expired login link; restart Fulcrum for a new one", 401);
    }
    // Burn the code immediately. Whoever used it first (the browser Fulcrum opened) is the only one who ever gets a session.
    loginCode = null; // single use
    const sessionId = randomBytes(32).toString("hex");
    sessions.add(sessionId);
    // The cookie value is a fresh random id, NOT the login code. HttpOnly keeps page scripts away from it; SameSite=Strict keeps other sites from sending it.
    setCookie(c, SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: "Strict", path: "/" });
    return c.redirect("/", 303);
  });

  app.use("*", async (c, next) => {
    if (!sessions.has(sessionOf(c))) {
      return c.html(page("Fulcrum", "<p>Open the link Fulcrum opened in your browser.</p>"), 401);
    }
    if (c.req.method === "POST") {
      // Browsers always send Origin on form POSTs. curl does not, unless the caller fakes it, and without the cookie and CSRF token that still fails.
      const origin = c.req.header("origin");
      if (origin === undefined || !allowedOrigins.has(origin)) return c.text("forbidden origin", 403);
    }
    await next();
  });

  app.get("/", (c) => c.html(listPage(gate, csrfFor(sessionOf(c)), undefined, proposals, labels)));

  // Shared handler for the Approve and Reject buttons. The approver name typed here is what goes into the ledger as approved_by.
  async function decide(c: Context, kind: "approve" | "reject") {
    const id = c.req.param("id") ?? "";
    const body = await c.req.parseBody();
    const csrf = body["csrf"];
    // Second line of defence after the Origin check: the token must match THIS session.
    if (typeof csrf !== "string" || !safeEqual(csrf, csrfFor(sessionOf(c)))) return c.text("bad csrf token", 403);
    const raw = body["name"];
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name === "") return c.text("approver name is required", 400);
    try {
      gate.status(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("unknown action")) return c.text("unknown action", 404);
      return c.text(scrub(`internal error: ${msg}`), 500);
    }
    let result: ActionView;
    try {
      result = kind === "approve" ? await gate.approve(id, name) : gate.reject(id, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(listPage(gate, csrfFor(sessionOf(c)), `Refused: ${msg}`, proposals, labels), 400);
    }
    const done = kind === "approve" ? result.status === "executed" : result.status === "rejected";
    if (done) return c.redirect("/", 303);
    return c.html(listPage(gate, csrfFor(sessionOf(c)), `Not ${kind === "approve" ? "executed" : "rejected"} (${result.status}): ${result.reason}`, proposals, labels));
  }

  app.post("/approve/:id", (c) => decide(c, "approve"));
  app.post("/reject/:id", (c) => decide(c, "reject"));

  // Proposals use the same session, Origin and CSRF checks (the middleware above covers every POST).
  async function decideProposal(c: Context, kind: "approve" | "reject") {
    if (!proposals) return c.text("unknown action", 404);
    const id = c.req.param("id") ?? "";
    const body = await c.req.parseBody();
    const csrf = body["csrf"];
    if (typeof csrf !== "string" || !safeEqual(csrf, csrfFor(sessionOf(c)))) return c.text("bad csrf token", 403);
    const raw = body["name"];
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name === "") return c.text("approver name is required", 400);
    if (!proposals.has(id)) return c.text("unknown action", 404);
    let result: ProposalView;
    try {
      result = kind === "approve" ? await proposals.approve(id, name) : proposals.reject(id, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(listPage(gate, csrfFor(sessionOf(c)), scrub(`Refused: ${msg}`), proposals, labels), 400);
    }
    const done = kind === "approve" ? result.status === "executed" : result.status === "rejected";
    if (done) return c.redirect("/", 303);
    return c.html(listPage(gate, csrfFor(sessionOf(c)), `Not ${kind === "approve" ? "executed" : "rejected"} (${result.status}): ${result.reason}`, proposals, labels));
  }
  app.post("/proposals/:id/approve", (c) => decideProposal(c, "approve"));
  app.post("/proposals/:id/reject", (c) => decideProposal(c, "reject"));

  app.get("/ledger", (c) => {
    const entries = (ledger?.all() ?? []).slice(-LEDGER_LIMIT).reverse();
    const rows = entries
      .map(
        (e) =>
          `<tr><td>${escapeHtml(e.ts)}</td><td>${escapeHtml(e.tool)}</td><td>${escapeHtml(e.testId)}</td><td>${escapeHtml(e.status)}</td><td>${escapeHtml(e.verdict)}</td><td>${escapeHtml(e.reason)}</td><td>${escapeHtml(e.approvedBy ?? "")}</td><td>${escapeHtml(JSON.stringify(e.args))}</td><td>${escapeHtml(e.id)}</td></tr>`,
      )
      .join("");
    return c.html(
      page(
        "Fulcrum ledger",
        `<h1>Ledger (last ${LEDGER_LIMIT})</h1><table><tr><th>Time</th><th>Tool</th><th>Test</th><th>Status</th><th>Verdict</th><th>Reason</th><th>Approved by</th><th>Args</th><th>Id</th></tr>${rows}</table><p><a href="/">Back</a></p>`,
      ),
    );
  });

  return app;
}

// Starts the server. Both secrets are random per run and never logged, so restarting Fulcrum invalidates every old link and session.
export function startApprovalPage(
  gate: Gate,
  port = 8787,
  ledger?: Ledger,
  log: (message: string) => void = createLogger("").log,
  openBrowser: (url: string) => void = defaultOpen(log),
  proposals?: Proposals,
  labels?: StopLabels,
): void {
  // In memory only: never logged, written or printed.
  const loginCode = randomBytes(32).toString("hex");
  const csrfSecret = randomBytes(32).toString("hex");
  const app = buildApprovalApp(gate, ledger, { port, loginCode, csrfSecret, ...(proposals ? { proposals } : {}), ...(labels ? { labels } : {}) });
  let failed = false;
  // Listen on 127.0.0.1 only, never 0.0.0.0, so nothing on the network can reach the page.
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    if (failed) return;
    log(`approval page on http://127.0.0.1:${port}`);
    if (process.env.FULCRUM_NO_BROWSER !== "1") {
      // The login link goes straight to the browser via `open`, not to stdout or a log, so the agent can't read it from Fulcrum's output.
      openBrowser(`http://127.0.0.1:${port}/login?t=${loginCode}`);
    }
  });
  server.on("error", (err: Error) => {
    failed = true;
    log(`approval page error: ${err.message}`);
  });
}

function defaultOpen(log: (message: string) => void): (url: string) => void {
  return (url) => {
    execFile("open", [url], (err) => {
      if (err) log("approval page: could not open browser");
    });
  };
}
