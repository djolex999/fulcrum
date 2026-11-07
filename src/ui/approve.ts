import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Ledger } from "../gate/ledger.js";
import type { ActionView, createGate } from "../gate/pending.js";
import { createLogger } from "../mcp/log.js";

type Gate = ReturnType<typeof createGate>;

const LEDGER_LIMIT = 20;

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

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface ApprovalSecrets {
  sessionSecret: string;
  csrfSecret: string;
}

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

function listPage(gate: Gate, csrf: string, notice?: string): string {
  const rows = gate.pending().map((a) => pendingRow(a, csrf)).join("");
  const note = notice ? `<p class="notice">${escapeHtml(notice)}</p>` : "";
  const table = rows
    ? `<table><tr><th>Test</th><th>Winner arm</th><th>Metric</th><th>Verdict</th><th>Reason</th><th>Agent rationale</th><th>Created</th><th>Decision</th></tr>${rows}</table>`
    : "<p>No pending actions.</p>";
  return page("Fulcrum approvals", `<h1>Fulcrum: pending approvals</h1>${note}${table}<p><a href="/ledger">Ledger</a></p>`);
}

export function buildApprovalApp(
  gate: Gate,
  ledger: Ledger | undefined,
  opts: ApprovalSecrets & { port?: number },
): Hono {
  const port = opts.port ?? 8787;
  const { sessionSecret, csrfSecret } = opts;
  const { scrub } = createLogger("");
  const app = new Hono();
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
  });

  // DNS-rebinding guard.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host === undefined || !allowedHosts.has(host)) return c.text("forbidden host", 421);
    await next();
  });

  app.get("/login", (c) => {
    const t = c.req.query("t") ?? "";
    if (!safeEqual(t, sessionSecret)) return c.text("invalid login link", 401);
    setCookie(c, SESSION_COOKIE, sessionSecret, { httpOnly: true, sameSite: "Strict", path: "/" });
    return c.redirect("/", 303);
  });

  app.use("*", async (c, next) => {
    const cookie = getCookie(c, SESSION_COOKIE) ?? "";
    if (!safeEqual(cookie, sessionSecret)) {
      return c.html(page("Fulcrum", "<p>Open the link Fulcrum opened in your browser.</p>"), 401);
    }
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin === undefined || !allowedOrigins.has(origin)) return c.text("forbidden origin", 403);
    }
    await next();
  });

  app.get("/", (c) => c.html(listPage(gate, csrfSecret)));

  async function decide(c: Context, kind: "approve" | "reject") {
    const id = c.req.param("id") ?? "";
    const body = await c.req.parseBody();
    const csrf = body["csrf"];
    if (typeof csrf !== "string" || !safeEqual(csrf, csrfSecret)) return c.text("bad csrf token", 403);
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
      return c.html(listPage(gate, csrfSecret, `Refused: ${msg}`), 400);
    }
    const done = kind === "approve" ? result.status === "executed" : result.status === "rejected";
    if (done) return c.redirect("/", 303);
    return c.html(listPage(gate, csrfSecret, `Not ${kind === "approve" ? "executed" : "rejected"} (${result.status}): ${result.reason}`));
  }

  app.post("/approve/:id", (c) => decide(c, "approve"));
  app.post("/reject/:id", (c) => decide(c, "reject"));

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

export function startApprovalPage(
  gate: Gate,
  port = 8787,
  ledger?: Ledger,
  log: (message: string) => void = createLogger("").log,
  openBrowser: (url: string) => void = defaultOpen(log),
): void {
  // In memory only: never logged, written or printed.
  const sessionSecret = randomBytes(32).toString("hex");
  const csrfSecret = randomBytes(32).toString("hex");
  const app = buildApprovalApp(gate, ledger, { port, sessionSecret, csrfSecret });
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  server.on("error", (err: Error) => {
    log(`approval page error: ${err.message}`);
  });
  log(`approval page on http://127.0.0.1:${port}`);
  if (process.env.FULCRUM_NO_BROWSER !== "1") {
    openBrowser(`http://127.0.0.1:${port}/login?t=${sessionSecret}`);
  }
}

function defaultOpen(log: (message: string) => void): (url: string) => void {
  return (url) => {
    execFile("open", [url], (err) => {
      if (err) log("approval page: could not open browser");
    });
  };
}
