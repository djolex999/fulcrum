import { randomUUID } from "node:crypto";
import { AdaptyCliError, type AdaptyCli } from "../adapty/cli.js";
import type { ApprovedStop } from "../adapty/types.js";
import { redactSecrets } from "../safety/secrets.js";
import type { ActionStatus, Ledger } from "./ledger.js";

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
  code?: "DUPLICATE_PENDING";
}

interface Action extends ActionView {
  rationale: string;
  inFlight: boolean;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

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

  const view = (a: Action): ActionView => {
    const { rationale: _r, inFlight: _f, ...rest } = a;
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

  async function runJudge(testId: string, opts: { asOf?: Date; metric?: string }) {
    try {
      return await judge(testId, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        verdict: "NO_WINNER" as const,
        reasons: [`judge failed: ${redactSecrets(msg)}`],
      };
    }
  }

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
        code: "DUPLICATE_PENDING",
      };
    }

    const result = await runJudge(i.testId, {
      metric: i.metric,
      ...(i.asOf ? { asOf: i.asOf } : {}),
    });
    base.verdict = result.verdict;

    if (i.asOf) {
      base.reason = "replay only";
    } else if (result.verdict !== "WINNER") {
      base.reason = result.reasons.join("; ") || `judge verdict ${result.verdict}`;
    } else if (result.winnerArmId !== i.winnerArmId) {
      base.reason = `judge winner arm ${result.winnerArmId ?? "none"} does not match requested arm ${i.winnerArmId}`;
    } else {
      base.status = "pending";
      base.reason = result.reasons.join("; ") || "awaiting human approval";
    }
    base.reason = redactSecrets(base.reason);
    actions.set(id, base);
    record(base, "request_stop");
    return { actionId: id, status: base.status === "pending" ? "pending" : "blocked", reason: base.reason };
  }

  function get(actionId: string): Action {
    const a = actions.get(actionId);
    if (!a) throw new Error(`unknown action ${actionId}`);
    return a;
  }

  async function approve(actionId: string, approvedBy: string): Promise<ActionView> {
    const a = get(actionId);
    const who = approvedBy.trim();
    if (who === "") throw new Error("approvedBy is required");

    if (a.status === "executed") return { ...view(a), reason: "already executed" };
    if (a.inFlight) return view(a);
    if (a.status !== "pending") return view(a);
    if (expireIfStale(a)) return view(a);

    a.inFlight = true; // set synchronously, before any await
    try {
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
