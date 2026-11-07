// The proposal queue: the second door, for a NEW test proposed by the agent. It is separate from the stop
// gate (src/gate/pending.ts) on purpose, so the stop path stays exactly as it was.
// Flow: requestProposal -> policy check -> pending -> a human in policy.approvers approves -> policy is
// checked AGAIN -> only then the CLI runs `ab-tests create`, once. That creates a DRAFT. Starting the test
// stays a human decision in Adapty: Fulcrum never starts anything.
// Same invariants as stops: ledger first (same ledger), a per-placement reservation, DUPLICATE_PENDING,
// 30 minute expiry, inFlight before the first await, at most once, failed with a redacted reason and no retry.

import { randomUUID } from "node:crypto";
import { AdaptyCliError, type AdaptyCli } from "../adapty/cli.js";
import type { AbTestSummary, ApprovedCreate, Audience, Placement } from "../adapty/types.js";
import { checkCreate, isApprover, type PolicyState } from "../policy/policy.js";
import { redactSecrets } from "../safety/secrets.js";
import type { ActionStatus, Ledger } from "./ledger.js";

export const DRAFT_NOTE = "Fulcrum will create the test as a draft; starting it is your decision in Adapty.";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
// The goal written into Adapty, structured so a human and the verdict engine read the same thing.
const GOAL_METRIC = "rpi_60d";
const HORIZON_DAYS = 60;
const GOAL_K = 15;

export interface ProposalRequest {
  placement: Placement;
  flows: [{ flowId: string; flowName: string }, { flowId: string; flowName: string }];
  /** Share of traffic for the second flow (percent). The first flow gets the rest. */
  challengerWeight: number;
  audience: Audience;
  hypothesis: string;
  title: string;
}

export interface ProposalView {
  actionId: string;
  status: ActionStatus;
  reason: string;
  /** The policy rule that blocked it, if one did. */
  policyRule?: string;
  createdAt: string;
  placementId: string;
  placement: string;
  placementTitle: string;
  title: string;
  /** Control first, challenger second. */
  flows: { flowId: string; flowName: string; weight: number }[];
  /** "all" or a segment id. */
  audience: string;
  hypothesis: string;
  goal: string;
  approvedBy?: string;
  executedAt?: string;
  /** The draft's id once `ab-tests create` succeeded. */
  createdTestId?: string;
  cliExit?: number;
}

export interface ProposalResult {
  actionId: string;
  status: "blocked" | "pending";
  reason: string;
  policyRule?: string;
  code?: string;
  /** Things that do not block but matter, e.g. an existing draft on the placement. */
  notes: string[];
}

interface Proposal extends ProposalView {
  inFlight: boolean;
}

const clean = (text: string, max: number): string => redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, max);

export function createProposals(deps: {
  cli: Partial<Pick<AdaptyCli, "createTest" | "listTests">>;
  ledger: Ledger;
  policy: PolicyState;
  now?: () => Date;
  ttlMs?: number;
}) {
  const { cli, ledger } = deps;
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const items = new Map<string, Proposal>();
  // placement developer id -> action id, held synchronously while a request awaits the live-test list.
  const reserved = new Map<string, string>();

  const view = (p: Proposal): ProposalView => {
    const { inFlight: _f, ...rest } = p;
    return { ...rest, flows: rest.flows.map((f) => ({ ...f })) };
  };

  function record(p: Proposal, tool: string): void {
    ledger.append({
      id: p.actionId,
      ts: now().toISOString(),
      tool,
      testId: p.createdTestId ?? `placement:${p.placement}`,
      args: {
        placementId: p.placementId,
        placement: p.placement,
        flows: p.flows,
        audience: p.audience,
        title: p.title,
        goal: p.goal,
        hypothesis: p.hypothesis,
      },
      verdict: "POLICY",
      status: p.status,
      reason: p.reason,
      ...(p.approvedBy !== undefined ? { approvedBy: p.approvedBy } : {}),
      ...(p.cliExit !== undefined ? { cliExit: p.cliExit } : {}),
    });
  }

  // Lazy expiry, like stops: checked whenever someone looks at the proposal.
  function expireIfStale(p: Proposal): boolean {
    if (p.status !== "pending" || now().getTime() - new Date(p.createdAt).getTime() <= ttlMs) return false;
    p.status = "expired";
    p.reason = "approval window elapsed";
    record(p, "expire_create");
    return true;
  }

  // Executed writes today (UTC), from the durable ledger: stops and creates both count, a restart does not reset it.
  function writesToday(): number {
    const today = now().toISOString().slice(0, 10);
    return ledger.all().filter((e) => e.tool.startsWith("execute_") && e.status === "executed" && e.ts.slice(0, 10) === today).length;
  }

  async function liveTests(): Promise<AbTestSummary[]> {
    if (!cli.listTests) throw new Error("listing tests is not available");
    return cli.listTests();
  }

  const invalid = (state: Extract<PolicyState, { ok: false }>): string => `invalid policy: ${state.reason}; every proposal is blocked until fulcrum.policy.json is fixed`;

  async function requestProposal(i: ProposalRequest): Promise<ProposalResult> {
    const id = randomUUID();
    const hypothesis = clean(i.hypothesis, 500);
    const goal = `goal: ${GOAL_METRIC}; horizon_days: ${HORIZON_DAYS}; K: ${GOAL_K}; hypothesis: ${hypothesis}`;
    const p: Proposal = {
      actionId: id,
      status: "blocked",
      reason: "",
      createdAt: now().toISOString(),
      placementId: i.placement.id,
      placement: i.placement.developerId,
      placementTitle: clean(i.placement.title, 120),
      title: clean(i.title, 120),
      flows: [
        { flowId: i.flows[0].flowId, flowName: clean(i.flows[0].flowName, 120), weight: 100 - i.challengerWeight },
        { flowId: i.flows[1].flowId, flowName: clean(i.flows[1].flowName, 120), weight: i.challengerWeight },
      ],
      audience: i.audience === "all" ? "all" : i.audience.segmentId,
      hypothesis,
      goal,
      inFlight: false,
    };
    const key = i.placement.developerId;

    // Fail closed: no valid policy, nothing is ever pending.
    if (!deps.policy.ok) {
      p.policyRule = "invalid_policy";
      p.reason = redactSecrets(invalid(deps.policy));
      record(p, "request_create");
      items.set(id, p);
      return { actionId: id, status: "blocked", reason: p.reason, policyRule: "invalid_policy", notes: [] };
    }
    const policy = deps.policy.policy;

    const dup = (existingId: string, inProgress: boolean): ProposalResult => {
      p.reason = `DUPLICATE_PENDING: action ${existingId} ${inProgress ? "is already being requested" : "is already pending"} for this placement`;
      record(p, "request_create");
      return { actionId: existingId, status: "pending", reason: p.reason, code: "DUPLICATE_PENDING", policyRule: inProgress ? "in_progress" : "duplicate_pending", notes: [] };
    };
    const inProgress = reserved.get(key);
    if (inProgress !== undefined) return dup(inProgress, true);
    for (const e of items.values()) {
      if (e.placement !== key || e.status !== "pending") continue;
      if (expireIfStale(e)) continue;
      return dup(e.actionId, false);
    }

    reserved.set(key, id); // synchronous, before the first await
    try {
      let notes: string[] = [];
      try {
        const r = checkCreate(
          policy,
          { placementDeveloperId: key, placementTitle: i.placement.title, challengerWeight: i.challengerWeight, writesToday: writesToday() },
          await liveTests(),
        );
        if (r.ok) {
          p.status = "pending";
          notes = r.notes;
          p.reason = [...r.notes, DRAFT_NOTE].join("; ");
        } else {
          p.reason = r.reason;
          p.policyRule = r.rule;
        }
      } catch (err) {
        // Cannot see the live tests, so we cannot prove there is no conflict: fail closed.
        p.reason = `cannot verify live tests: ${err instanceof Error ? err.message : String(err)}`;
        p.policyRule = "live_tests_unverifiable";
      }
      p.reason = redactSecrets(p.reason);
      record(p, "request_create"); // ledger first: if this throws, no proposal exists
      items.set(id, p);
      return {
        actionId: id,
        status: p.status === "pending" ? "pending" : "blocked",
        reason: p.reason,
        ...(p.policyRule !== undefined ? { policyRule: p.policyRule } : {}),
        notes,
      };
    } finally {
      reserved.delete(key);
    }
  }

  function get(actionId: string): Proposal {
    const p = items.get(actionId);
    if (!p) throw new Error(`unknown action ${actionId}`);
    return p;
  }

  const has = (actionId: string): boolean => items.has(actionId);

  async function approve(actionId: string, approvedBy: string): Promise<ProposalView> {
    const p = get(actionId);
    const who = approvedBy.trim();
    if (who === "") throw new Error("approvedBy is required");
    if (p.status === "executed") return { ...view(p), reason: "already executed" };
    if (p.inFlight) return view(p);
    if (p.status !== "pending") return view(p);
    if (expireIfStale(p)) return view(p);
    if (!deps.policy.ok) {
      return { ...view(p), reason: redactSecrets(`refused: ${invalid(deps.policy)}`) };
    }
    const policy = deps.policy.policy;
    // Status stays pending: a wrong name does not burn the proposal.
    if (!isApprover(policy, who)) return { ...view(p), reason: `refused: ${who} is not in the policy approvers` };
    for (const o of items.values()) {
      if (o.actionId !== p.actionId && o.placement === p.placement && o.inFlight) {
        return { ...view(p), reason: `refused: another proposal for this placement is in flight (action ${o.actionId})` };
      }
    }

    p.inFlight = true; // set synchronously, before any await
    try {
      // Re-check at approval time: a test may have gone live on the placement since the proposal.
      try {
        const r = checkCreate(
          policy,
          { placementDeveloperId: p.placement, placementTitle: p.placementTitle, challengerWeight: p.flows[1]?.weight ?? 100, writesToday: writesToday() },
          await liveTests(),
        );
        if (!r.ok) {
          p.status = "blocked";
          p.policyRule = r.rule;
          p.reason = redactSecrets(`policy re-check at approval blocked it: ${r.reason}`);
          record(p, "approve_create");
          return view(p);
        }
      } catch (err) {
        p.status = "blocked";
        p.policyRule = "live_tests_unverifiable";
        p.reason = redactSecrets(`policy re-check at approval could not verify live tests: ${err instanceof Error ? err.message : String(err)}`);
        record(p, "approve_create");
        return view(p);
      }

      p.status = "approved";
      p.approvedBy = who;
      p.reason = "approved by human";
      record(p, "approve_create"); // ledger before the CLI, as for stops

      const [first, second] = p.flows;
      // The only place an ApprovedCreate is constructed.
      const token = {
        placementId: p.placementId,
        flows: [
          { flowId: first?.flowId ?? "", weight: first?.weight ?? 0, title: "A" },
          { flowId: second?.flowId ?? "", weight: second?.weight ?? 0, title: "B" },
        ],
        audience: p.audience === "all" ? "all" : { segmentId: p.audience },
        title: p.title,
        goal: p.goal,
      } as ApprovedCreate;
      try {
        if (!cli.createTest) throw new Error("creating tests is not available");
        const { abTestId } = await cli.createTest(token);
        p.createdTestId = abTestId;
        p.status = "executed";
        p.executedAt = now().toISOString();
        p.reason = `draft ${abTestId} created; starting it is your decision in Adapty`;
      } catch (err) {
        p.status = "failed";
        if (err instanceof AdaptyCliError) p.cliExit = err.code;
        p.reason = redactSecrets(`create failed, nothing was retried: ${err instanceof Error ? err.message : String(err)}`);
      }
      record(p, "execute_create");
      return view(p);
    } finally {
      p.inFlight = false;
    }
  }

  function reject(actionId: string, by: string): ProposalView {
    const p = get(actionId);
    if (by.trim() === "") throw new Error("rejecting identity is required");
    if (p.status === "pending" && !p.inFlight) {
      p.status = "rejected";
      p.reason = `rejected by ${by.trim()}`;
      record(p, "reject_create");
    }
    return view(p);
  }

  function status(actionId: string): ProposalView {
    const p = get(actionId);
    expireIfStale(p);
    return view(p);
  }

  function pending(): ProposalView[] {
    return [...items.values()].filter((p) => !expireIfStale(p) && p.status === "pending").map(view);
  }

  return { requestProposal, approve, reject, status, pending, has };
}

export type Proposals = ReturnType<typeof createProposals>;
