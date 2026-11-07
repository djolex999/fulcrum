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
import type { ProposalView, Proposals } from "../gate/proposals.js";
import { createLogger } from "../mcp/log.js";

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.4rem;text-align:left;vertical-align:top}
.notice{background:#fff3cd;padding:.6rem;border:1px solid #e0c36c}</style></head><body>${body}</body></html>`;
}

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

// The login link is valid for 1 minute and once. If you miss it, restart Fulcrum for a new one.
const LOGIN_TTL_MS = 60_000;

const SESSION_COOKIE = "fulcrum_session";

function pendingRow(a: ActionView, csrf: string): string {
  const id = encodeURIComponent(a.actionId);
  return `<tr><td>${escapeHtml(a.testId)}<br><small>${escapeHtml(a.actionId)}</small></td>
<td>${escapeHtml(a.winnerArmId)}</td><td>${escapeHtml(a.metric)}</td><td>${escapeHtml(a.verdict)}</td>
<td>${escapeHtml(a.reason)}</td><td>${escapeHtml(a.rationale)}</td><td>${escapeHtml(a.createdAt)}</td>
<td><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input name="name" placeholder="your name" required>
<button type="submit" formaction="/approve/${id}">Approve</button>
<button type="submit" formaction="/reject/${id}">Reject</button></form></td></tr>`;
}

// A proposed NEW test. Approving only creates it as a draft; starting it is a human decision in Adapty.
function proposalRow(a: ProposalView, csrf: string): string {
  const id = encodeURIComponent(a.actionId);
  const flows = a.flows.map((f, i) => `${i === 0 ? "Control" : "Challenger"}: ${escapeHtml(f.flowName)} (${escapeHtml(f.flowId)}), ${escapeHtml(f.weight)}%`).join("<br>");
  return `<tr><td>${escapeHtml(a.placement)}<br><small>${escapeHtml(a.placementTitle)}</small><br><small>${escapeHtml(a.actionId)}</small></td>
<td>${flows}</td><td>${escapeHtml(a.audience)}</td><td>${escapeHtml(a.hypothesis)}</td>
<td>${escapeHtml(a.reason)}</td><td>${escapeHtml(a.createdAt)}</td>
<td><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input name="name" placeholder="your name" required>
<button type="submit" formaction="/proposals/${id}/approve">Approve: create draft</button>
<button type="submit" formaction="/proposals/${id}/reject">Reject</button></form></td></tr>`;
}

function listPage(gate: Gate, csrf: string, notice?: string, proposals?: Proposals): string {
  const rows = gate.pending().map((a) => pendingRow(a, csrf)).join("");
  const prows = (proposals?.pending() ?? []).map((a) => proposalRow(a, csrf)).join("");
  const note = notice ? `<p class="notice">${escapeHtml(notice)}</p>` : "";
  const table = rows
    ? `<h2>Stop a test</h2><table><tr><th>Test</th><th>Winner arm</th><th>Metric</th><th>Verdict</th><th>Reason</th><th>Agent rationale</th><th>Created</th><th>Decision</th></tr>${rows}</table>`
    : "";
  const ptable = prows
    ? `<h2>Proposed new tests</h2><p>Approving creates the test as a draft only; starting it is your decision in Adapty.</p><table><tr><th>Placement</th><th>Flows</th><th>Audience</th><th>Hypothesis</th><th>Policy</th><th>Created</th><th>Decision</th></tr>${prows}</table>`
    : "";
  const body = table + ptable || "<p>No pending actions.</p>";
  return page("Fulcrum approvals", `<h1>Fulcrum: pending approvals</h1>${note}${body}<p><a href="/ledger">Ledger</a></p>`);
}

// Request path, in order: security headers -> Host check -> /login (one-time code, sets cookie)
// -> everything else needs a valid session cookie -> POSTs also need the right Origin and a CSRF token.
export function buildApprovalApp(
  gate: Gate,
  ledger: Ledger | undefined,
  opts: ApprovalSecrets & { port?: number; now?: () => number; proposals?: Proposals },
): Hono {
  const port = opts.port ?? 8787;
  const { csrfSecret, proposals } = opts;
  const now = opts.now ?? (() => Date.now());
  // The login code exists only in this process's memory and in the URL that Fulcrum opens in the user's browser. The agent never sees it.
  let loginCode: string | null = opts.loginCode;
  const loginExpiresAt = now() + LOGIN_TTL_MS;
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

  app.get("/", (c) => c.html(listPage(gate, csrfFor(sessionOf(c)), undefined, proposals)));

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
      return c.html(listPage(gate, csrfFor(sessionOf(c)), `Refused: ${msg}`, proposals), 400);
    }
    const done = kind === "approve" ? result.status === "executed" : result.status === "rejected";
    if (done) return c.redirect("/", 303);
    return c.html(listPage(gate, csrfFor(sessionOf(c)), `Not ${kind === "approve" ? "executed" : "rejected"} (${result.status}): ${result.reason}`, proposals));
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
      return c.html(listPage(gate, csrfFor(sessionOf(c)), scrub(`Refused: ${msg}`), proposals), 400);
    }
    const done = kind === "approve" ? result.status === "executed" : result.status === "rejected";
    if (done) return c.redirect("/", 303);
    return c.html(listPage(gate, csrfFor(sessionOf(c)), `Not ${kind === "approve" ? "executed" : "rejected"} (${result.status}): ${result.reason}`, proposals));
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
): void {
  // In memory only: never logged, written or printed.
  const loginCode = randomBytes(32).toString("hex");
  const csrfSecret = randomBytes(32).toString("hex");
  const app = buildApprovalApp(gate, ledger, { port, loginCode, csrfSecret, ...(proposals ? { proposals } : {}) });
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
