// The approval gate: the only place a stop request becomes a real Adapty write.
// Flow: agent calls requestStop -> we judge it -> WINNER makes it "pending" (anything else is "blocked")
// -> a human approves in the browser UI -> we judge AGAIN -> only then the CLI stop runs, once.
// There is no approve tool for the agent. Only the approval page calls approve().
// Everything is in memory; the ledger (append-only) is the durable audit trail.

import { randomUUID } from "node:crypto";
import { AdaptyCliError, type AdaptyCli } from "../adapty/cli.js";
import type { ApprovedStop } from "../adapty/types.js";
import { redactSecrets } from "../safety/secrets.js";
import type { ActionStatus, Ledger } from "./ledger.js";

// The gate does not know any statistics. It gets a judge function and trusts its verdict.
// If the judge throws, we treat that as "no winner" (see runJudge), never as a win.
export type Judge = (
  testId: string,
  opts: { asOf?: Date; metric?: string },
) => Promise<{
  verdict: "WINNER" | "CONTINUE" | "NO_WINNER";
  winnerArmId?: string;
  reasons: string[];
  code?: string;
}>;

export interface ActionView {
  actionId: string;
  testId: string;
  winnerArmId: string;
  metric: string;
  status: ActionStatus;
  reason: string;
  verdict: string;
  createdAt: string;
  approvedBy?: string;
  executedAt?: string;
  cliExit?: number;
  /** Agent-supplied rationale, already redacted. */
  rationale: string;
}

export interface StopRequest {
  testId: string;
  winnerArmId: string;
  metric: string;
  rationale: string;
  asOf?: Date;
}

export interface StopRequestResult {
  actionId: string;
  status: "blocked" | "pending";
  reason: string;
  /** Judge verdict (or the existing action's verdict for a duplicate). */
  verdict: string;
  /** Judge code (e.g. BEFORE_HORIZON, METRIC_NOT_GOAL) or DUPLICATE_PENDING. */
  code?: string;
  /** The judge's full output, when it ran. Absent if the judge failed. */
  detail?: Record<string, unknown>;
}

// Internal action record. inFlight is private to the gate (view() strips it): it is true while an
// approval is running, so a double-click or a second tab cannot trigger two stops.
interface Action extends ActionView {
  inFlight: boolean;
}

// A pending request expires after 30 minutes. The verdict was true when it was requested; a human
// who comes back much later must have the agent ask again, so the data is fresh.
const DEFAULT_TTL_MS = 30 * 60 * 1000;

// Everything below shares closures over `actions` (all requests this process knows) and `reserved`.
export function createGate(deps: {
  cli: Pick<AdaptyCli, "stopTest">;
  ledger: Ledger;
  judge: Judge;
  now?: () => Date;
  ttlMs?: number;
}) {
  const { cli, ledger, judge } = deps;
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const actions = new Map<string, Action>();
  // Per-test reservation. Two request_stop calls for the same test can arrive at the same moment.
  // The second one must see that the first one is still being judged, so we claim the test
  // synchronously (before any await) and release it in a finally block.
  // testId -> actionId, held synchronously while a request awaits the judge.
  const reserved = new Map<string, string>();

  const view = (a: Action): ActionView => {
    const { inFlight: _f, ...rest } = a;
    return { ...rest };
  };

  function record(a: Action, tool: string): void {
    ledger.append({
      id: a.actionId,
      ts: now().toISOString(),
      tool,
      testId: a.testId,
      args: { winnerArmId: a.winnerArmId, metric: a.metric, rationale: a.rationale },
      verdict: a.verdict,
      status: a.status,
      reason: a.reason,
      ...(a.approvedBy !== undefined ? { approvedBy: a.approvedBy } : {}),
      ...(a.cliExit !== undefined ? { cliExit: a.cliExit } : {}),
    });
  }

  // Expiry is lazy: nothing runs on a timer. We check the age whenever someone looks at the action
  // (status, pending list, approve, or a new request for the same test) and write an "expire_stop" ledger entry then.
  const isExpired = (a: Action): boolean =>
    now().getTime() - new Date(a.createdAt).getTime() > ttlMs;

  /** Marks a stale pending action expired. Returns true if it expired. */
  function expireIfStale(a: Action): boolean {
    if (a.status !== "pending" || !isExpired(a)) return false;
    a.status = "expired";
    a.reason = "approval window elapsed";
    record(a, "expire_stop");
    return true;
  }

  // Wraps the judge so it can never throw into the gate. A failed judge becomes NO_WINNER, so the
  // request is blocked (fail closed). The error text is redacted because it may come from the CLI.
  async function runJudge(
    testId: string,
    opts: { asOf?: Date; metric?: string },
  ): Promise<Awaited<ReturnType<Judge>> & { detail?: Record<string, unknown> }> {
    try {
      const r = await judge(testId, opts);
      return { ...r, detail: r as Record<string, unknown> };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        verdict: "NO_WINNER",
        reasons: [`judge failed: ${redactSecrets(msg)}`],
      };
    }
  }

  // Step 1 of the flow. Always writes exactly one ledger entry. Returns "pending" only if the judge
  // says WINNER and the winner is the very arm the agent asked for. Everything else is "blocked".
  async function requestStop(i: StopRequest): Promise<StopRequestResult> {
    const id = randomUUID();
    const base: Action = {
      actionId: id,
      testId: i.testId,
      winnerArmId: i.winnerArmId,
      metric: i.metric,
      status: "blocked",
      reason: "",
      verdict: "",
      createdAt: now().toISOString(),
      rationale: redactSecrets(i.rationale),
      inFlight: false,
    };

    const optsBase = { metric: i.metric };

    // A replay (asOf = a past date) is a "what would the verdict have been then" question.
    // You cannot stop a test in the past, so a replay is never stored as pending. It is
    // always "blocked" with "replay only", and it is logged so the question stays auditable.
    // Replay: always runs the judge, never pending, never a duplicate.
    if (i.asOf) {
      const result = await runJudge(i.testId, { ...optsBase, asOf: i.asOf });
      base.verdict = result.verdict;
      base.reason = redactSecrets([...result.reasons, "replay only"].join("; "));
      record(base, "request_stop");
      actions.set(id, base);
      return {
        actionId: id,
        status: "blocked",
        reason: base.reason,
        verdict: result.verdict,
        ...(result.code !== undefined ? { code: result.code } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      };
    }

    // Two duplicate checks. First: another request for this test is still awaiting the judge (the
    // reservation). Second, below: one already finished and is waiting for a human. In both cases the
    // agent gets the existing action back instead of a second pending stop for the same test.
    const inProgress = reserved.get(i.testId);
    if (inProgress !== undefined) {
      base.reason = `DUPLICATE_PENDING: action ${inProgress} is already being requested for this test`;
      base.verdict = "UNKNOWN";
      record(base, "request_stop");
      return {
        actionId: inProgress,
        status: "pending",
        reason: base.reason,
        verdict: base.verdict,
        code: "DUPLICATE_PENDING",
      };
    }
    for (const existing of actions.values()) {
      if (existing.testId !== i.testId || existing.status !== "pending") continue;
      if (expireIfStale(existing)) continue;
      base.reason = `DUPLICATE_PENDING: action ${existing.actionId} is already pending for this test`;
      base.verdict = existing.verdict;
      record(base, "request_stop");
      return {
        actionId: existing.actionId,
        status: "pending",
        reason: base.reason,
        verdict: existing.verdict,
        code: "DUPLICATE_PENDING",
      };
    }

    // Claim the test now, in the same tick as the check above. If we claimed it after the await,
    // two simultaneous requests would both pass the check and both become pending.
    reserved.set(i.testId, id); // synchronous, before the first await
    try {
      const result = await runJudge(i.testId, optsBase);
      base.verdict = result.verdict;
      if (result.verdict !== "WINNER") {
        base.reason = result.reasons.join("; ") || `judge verdict ${result.verdict}`;
      } else if (result.winnerArmId !== i.winnerArmId) {
        base.reason = `judge winner arm ${result.winnerArmId ?? "none"} does not match requested arm ${i.winnerArmId}`;
      } else {
        base.status = "pending";
        base.reason = result.reasons.join("; ") || "awaiting human approval";
      }
      base.reason = redactSecrets(base.reason);
      // Order matters: write the ledger first, store the action second. If the ledger write fails
      // (disk error), no action exists in memory, so nothing can be approved without an audit entry.
      // The reservation is released in finally, so a thrown error never locks the test forever.
      record(base, "request_stop"); // ledger first: if this throws, no action exists
      actions.set(id, base);
      return {
        actionId: id,
        status: base.status === "pending" ? "pending" : "blocked",
        reason: base.reason,
        verdict: result.verdict,
        ...(result.code !== undefined ? { code: result.code } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      };
    } finally {
      reserved.delete(i.testId);
    }
  }

  function get(actionId: string): Action {
    const a = actions.get(actionId);
    if (!a) throw new Error(`unknown action ${actionId}`);
    return a;
  }

  // Steps 2 and 3, called only by the human approval page. It re-judges before acting, because
  // the data may have changed since the request. Safe to call twice: the second call is a no-op.
  async function approve(actionId: string, approvedBy: string): Promise<ActionView> {
    const a = get(actionId);
    const who = approvedBy.trim();
    if (who === "") throw new Error("approvedBy is required");

    // Idempotency guards, cheapest first: already done, someone is mid-approval, not pending anymore,
    // or too old. Only a fresh pending action gets past all four.
    if (a.status === "executed") return { ...view(a), reason: "already executed" };
    if (a.inFlight) return view(a);
    if (a.status !== "pending") return view(a);
    if (expireIfStale(a)) return view(a);

    // Defence in depth: even if two different actions exist for one test, only one stop may ever
    // run or be running. Without this, a second approval could stop an already stopped test.
    for (const other of actions.values()) {
      if (other.actionId === a.actionId || other.testId !== a.testId) continue;
      if (other.inFlight || other.status === "executed") {
        return {
          ...view(a),
          reason: `refused: another stop for this test is ${other.status === "executed" ? "already executed" : "in flight"} (action ${other.actionId})`,
        };
      }
    }

    // Lock the action before the first await. JS only switches between requests at an await, so two
    // quick clicks on "Approve" are handled one after the other: the second sees inFlight and returns.
    a.inFlight = true; // set synchronously, before any await
    try {
      // Re-check at approval time. The human approves what they saw, but we only execute if the
      // numbers STILL say WINNER for the same arm. If not, the action is blocked and the CLI never runs.
      const result = await runJudge(a.testId, { metric: a.metric });
      if (result.verdict !== "WINNER" || result.winnerArmId !== a.winnerArmId) {
        a.status = "blocked";
        a.verdict = result.verdict;
        a.reason = redactSecrets(
          `re-judge at approval did not confirm the winner: ${result.reasons.join("; ") || result.verdict}`,
        );
        record(a, "approve_stop");
        return view(a);
      }

      // Record the approval in the ledger BEFORE calling the CLI. If the process dies mid-call, the
      // audit trail still shows who approved and that an execution was attempted.
      a.status = "approved";
      a.approvedBy = who;
      a.reason = "approved by human";
      record(a, "approve_stop");

      // The only place an ApprovedStop is constructed.
      const token = { abTestId: a.testId, winnerArmId: a.winnerArmId } as ApprovedStop;
      try {
        await cli.stopTest(token);
        a.status = "executed";
        a.executedAt = now().toISOString();
        a.reason = "stop executed";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        a.status = "failed";
        if (err instanceof AdaptyCliError) a.cliExit = err.code;
        a.reason = redactSecrets(`stop call failed or could not be confirmed: ${msg}`);
      }
      record(a, "execute_stop");
      return view(a);
    } finally {
      a.inFlight = false;
    }
  }

  // Reject only works on a pending action that is not mid-approval. It never touches the CLI.
  function reject(actionId: string, by: string): ActionView {
    const a = get(actionId);
    if (by.trim() === "") throw new Error("rejecting identity is required");
    if (a.status === "pending" && !a.inFlight) {
      a.status = "rejected";
      a.reason = `rejected by ${by.trim()}`;
      record(a, "reject_stop");
    }
    return view(a);
  }

  function status(actionId: string): ActionView {
    const a = get(actionId);
    expireIfStale(a);
    return view(a);
  }

  function pending(): ActionView[] {
    return [...actions.values()].filter((a) => !expireIfStale(a) && a.status === "pending").map(view);
  }

  return { requestStop, approve, reject, status, pending };
}
