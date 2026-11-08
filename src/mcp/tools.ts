// The tools the AI agent sees (MCP). Agent-centred on purpose: the agent can read tests, ask for
// a verdict, see the weekly timeline, ask to stop a test, look for signals, propose a new test and poll the request status.
// There is NO approve tool. Approval only exists on the human web page (src/ui/approve.ts),
// so a prompt-injected or confused agent cannot approve its own request.
// Every tool result passes through one scrub function, so a secret can't leave through any tool.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdaptyCli } from "../adapty/cli.js";
import type { AbTestDetail } from "../adapty/types.js";
import { AdaptyCliError } from "../adapty/cli.js";
import type { createGate, Judge } from "../gate/pending.js";
import type { Proposals } from "../gate/proposals.js";
import { goalMetricOf, type TestPlan } from "../stats/plans.js";
import { GOAL_K, GOAL_METRIC, HORIZON_DAYS } from "../gate/proposals.js";
import { checkArmMapping, flowOfArm, planForTitle, validArmsHint } from "./engine.js";
import type { StopLabels } from "../ui/labels.js";
import { ToolError } from "./errors.js";

type Gate = ReturnType<typeof createGate>;

// Where the numbers come from. Only the offline CSV is implemented; live Adapty metrics are not.
export type JudgeSource = "csv" | "adapty_metrics";

/** Full verdict engine output. The gate only needs the Judge subset. */
export type JudgeFn = (
  testId: string,
  opts: { asOf?: Date; metric?: string; source?: JudgeSource },
) => Promise<Awaited<ReturnType<Judge>> & Record<string, unknown>>;

export type TimelineFn = (testId: string, opts: { metric?: string }) => Promise<Record<string, unknown>>;

export { ToolError };

/** Until the verdict engine exists nothing can be approvable: never WINNER. */
export const placeholderJudge: JudgeFn = async () => ({
  verdict: "CONTINUE",
  reasons: ["verdict engine not built yet"],
});

export const placeholderTimeline: TimelineFn = async () => {
  throw new ToolError("NOT_IMPLEMENTED", "test_timeline is not implemented yet");
};

export interface ToolDeps {
  // listPlacements and listFlows are needed by propose_test only; without them it answers NOT_IMPLEMENTED.
  cli: Pick<AdaptyCli, "listTests" | "getTest"> & Partial<Pick<AdaptyCli, "listPlacements" | "listFlows">>;
  gate: Gate;
  /** The queue for proposed new tests. Without it propose_test answers NOT_IMPLEMENTED. */
  proposals?: Proposals;
  judge: JudgeFn;
  timeline: TimelineFn;
  /** The AI-edit signal for find_signals (read-only). Without it find_signals answers NOT_IMPLEMENTED. */
  signals?: () => Promise<Record<string, unknown>>;
  /** Test plans, joined to Adapty tests by title (list_tests goal and horizon; arm mapping check). */
  plans?: readonly TestPlan[];
  /** Display names for pending stops on the approval page (test title, arm name). Never used for decisions. */
  labels?: StopLabels;
  /** Where the human approves (shown to the agent in a pending reply). Defaults to the default port. */
  approvalUrl?: string;
  log?: (message: string) => void;
  // Redacts secrets from everything the agent receives (see ok/fail below).
  scrub?: (text: string) => string;
}

// as_of is agent input, so it is parsed strictly. A bad date becomes INVALID_AS_OF, never a surprise Date.
function parseAsOf(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const bad = (): ToolError => new ToolError("INVALID_AS_OF", "as_of must be a real date: YYYY-MM-DD or a full ISO timestamp");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // Looks are day-aligned at 00:00:00Z, so a date-only as_of lands on the right look.
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) throw bad();
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw bad();
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { cli, gate, judge, timeline } = deps;
  const plans = deps.plans ?? [];
  const approvalUrl = deps.approvalUrl ?? "http://127.0.0.1:8787/";
  const log = deps.log ?? (() => {});
  const scrub = deps.scrub ?? ((s: string) => s);

  // The single scrub path: success and failure results both go through scrub() right before they
  // leave the process. If you add a new tool, return through ok/fail and it is covered automatically.
  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: scrub(JSON.stringify(data)) }] });
  const fail = (code: string, message: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: scrub(JSON.stringify({ code, message })) }],
  });

  // Every tool is registered through this helper, so error handling and logging are identical.
  // Expected problems (ToolError) keep their code; CLI failures become ADAPTY_UNAVAILABLE.
  /** Wraps a handler: ToolError and CLI failures become isError results. */
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ): void {
    server.registerTool(name, { description, inputSchema: shape as z.ZodRawShape }, async (args: Record<string, unknown>) => {
      try {
        const out = await handler(args as z.infer<z.ZodObject<S>>);
        log(`${name} ok`);
        return ok(out);
      } catch (err) {
        if (err instanceof ToolError) {
          log(`${name} error ${err.code}`);
          return fail(err.code, err.message);
        }
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof AdaptyCliError ? "ADAPTY_UNAVAILABLE" : "INTERNAL";
        log(`${name} error ${code}: ${scrub(msg)}`);
        return fail(code, msg);
      }
    });
  }

  // Looks the test up in Adapty first, so a made-up id gets UNKNOWN_TEST instead of a confusing downstream error.
  async function resolveTest(testId: string): Promise<AbTestDetail> {
    const list = await cli.listTests();
    if (!list.some((t) => t.abTestId === testId)) {
      throw new ToolError("UNKNOWN_TEST", `no A/B test with id ${testId}`);
    }
    return cli.getTest(testId);
  }

  // list_tests: what exists, its state, and the goal metric and horizon from the test plan.
  tool("list_tests", "List the app's Adapty A/B tests. goal_metric is the only metric a verdict can be asked on. Use a test_id from the result with judge_test.", {}, async () => {
    const tests = await cli.listTests();
    return {
      tests: tests.map((t) => {
        const plan = planForTitle(plans, t.title);
        return {
          test_id: t.abTestId,
          title: t.title,
          state: t.state,
          placement: t.placementTitle,
          goal_metric: plan ? goalMetricOf(plan) : null,
          horizon_days: plan ? plan.horizonDays : null,
        };
      }),
    };
  });

  // judge_test: "does this test have a supported winner?" Read-only. With as_of it replays history
  // (CSV only, because live Adapty numbers can't be rewound).
  tool(
    "judge_test",
    "Judge whether a test has a statistically supported winner. as_of replays the verdict at a past date (csv source only). If not WINNER, the reasons say when to ask again or which metric to use.",
    {
      test_id: z.string(),
      as_of: z.string().optional(),
      metric: z.string().optional(),
      source: z.enum(["csv", "adapty_metrics"]).optional(),
    },
    async (a) => {
      const asOf = parseAsOf(a.as_of);
      const source = a.source ?? "csv";
      if (asOf && source !== "csv") {
        throw new ToolError("AS_OF_REQUIRES_CSV", "as_of replay needs the csv source; adapty_metrics is current-only");
      }
      await resolveTest(a.test_id);
      return judge(a.test_id, { ...(asOf ? { asOf } : {}), ...(a.metric ? { metric: a.metric } : {}), source });
    },
  );

  // test_timeline: every weekly look vs the boundary. This is the tool that shows WHEN a winner was
  // first supported, or that it never was.
  tool(
    "test_timeline",
    "Weekly looks of a test against the sequential boundary. Use it to see which look first crossed, or when the next look falls.",
    { test_id: z.string(), metric: z.string().optional() },
    async (a) => {
      await resolveTest(a.test_id);
      return timeline(a.test_id, a.metric ? { metric: a.metric } : {});
    },
  );

  // request_stop: the only way to try to change anything. It runs the judge once inside the gate. A
  // winner becomes "pending" for a human; everything else is "blocked" with the reason.
  tool(
    "request_stop",
    "Ask to stop a live test with a declared winner. With as_of (YYYY-MM-DD) it replays the request at a past date, on any test including completed ones: Fulcrum judges it and blocks it as replay only, never pending, so use it to ask 'would this stop have passed then?'. Fulcrum judges every request first; a human must approve in the Fulcrum UI. There is no approve tool. blocked means the reason gives the next step. pending means a human must approve at the approval page; poll request_status.",
    {
      test_id: z.string(),
      winner_arm_id: z.string(),
      metric: z.string(),
      rationale: z.string(),
      as_of: z.string().optional(),
    },
    async (a) => {
      const asOf = parseAsOf(a.as_of);
      const test = await resolveTest(a.test_id);
      // A replay (as_of) asks "what would the verdict have been then"; the gate never makes it pending or
      // executes it, so it is allowed on a test that has since ended. A real stop needs a live test.
      if (!asOf && test.state !== "live") {
        throw new ToolError("NOT_LIVE", `test ${a.test_id} is ${test.state}, only live tests can be stopped`);
      }
      if (!test.arms.some((arm) => arm.armId === a.winner_arm_id)) {
        throw new ToolError("UNKNOWN_ARM", `arm ${a.winner_arm_id} is not part of test ${a.test_id}. ${validArmsHint(test, planForTitle(plans, test.title))}`);
      }
      // Adapty arms are identified by flow_id, but the CSV stores flow names. The plan maps one to the
      // other (see engine.ts). Failing here is cheaper than judging the wrong arm.
      // With a plan, the requested arm must also map to a CSV flow through its Adapty flow name.
      const plan = planForTitle(plans, test.title);
      if (plan) {
        flowOfArm(plan, test, a.winner_arm_id);
        checkArmMapping(plan, test);
      }
      // Hand over to the gate. The gate calls the same judge function exactly once for this request;
      // the evidence below is read from that same result, so the answer can't contradict the decision.
      const r = await gate.requestStop({
        testId: a.test_id,
        winnerArmId: a.winner_arm_id,
        metric: a.metric,
        rationale: a.rationale,
        ...(asOf ? { asOf } : {}),
      });
      // Label only a NEW pending action, never overwrite one, and name the arm the gate stored (what Approve
      // will stop), not the arm in this request: a duplicate request returns the existing action's id.
      if (r.status === "pending" && r.code !== "DUPLICATE_PENDING" && deps.labels && !deps.labels.has(r.actionId)) {
        const stored = gate.status(r.actionId);
        if (stored.testId === test.abTestId) {
          const armName = test.arms.find((arm) => arm.armId === stored.winnerArmId)?.name ?? "";
          deps.labels.set(r.actionId, { testTitle: test.title, armName });
        }
      }
      // Two cases. verdict UNKNOWN: the first request is still being judged, so say "retry in a moment".
      // Otherwise a stop for this test is already waiting for a human, which is an error.
      if (r.code === "DUPLICATE_PENDING") {
        if (r.verdict === "UNKNOWN") {
          return {
            action_id: r.actionId,
            status: "blocked",
            verdict: r.verdict,
            reason: "request in progress, retry request_stop in a moment",
          };
        }
        throw new ToolError("DUPLICATE_PENDING", `action ${r.actionId} is already pending for this test`);
      }
      // Evidence comes from the very judge result the gate decided on (one call): it can't contradict the decision.
      const d = r.detail;
      // Pending: say who approves and where, and how to follow up. Blocked: the reason already carries
      // the verdict's next step (when to ask again, which metric to use), so it is passed through unchanged.
      const reason =
        r.status === "pending"
          ? `Next: a human must approve at ${approvalUrl}; poll request_status with action_id ${r.actionId}. ${r.reason}`
          : r.reason;
      return {
        action_id: r.actionId,
        status: r.status,
        verdict: r.verdict,
        reason,
        ...(r.code ? { code: r.code } : {}),
        ...(d
          ? {
              evidence: {
                verdict: d.verdict,
                ...(d.code !== undefined ? { code: d.code } : {}),
                goal_metric: d.goal_metric,
                look_k: d.look_k,
                K: d.K,
                z: d.z,
                boundary: d.boundary,
                effect: d.effect,
                p_naive: d.p_naive,
                ...(d.next_look !== undefined ? { next_look: d.next_look } : {}),
                source: d.source,
              },
            }
          : {}),
      };
    },
  );

  // find_signals: read-only. Where do users who do more of something pay more? That is where a new test is worth proposing.
  tool(
    "find_signals",
    "Read-only. Pay rate (share of users with a paid purchase, net of refunds) by AI edits on day one: 0, 1-4, 5+, with the number of users in each. If a segment converts much better, use propose_test on a placement those users see.",
    {},
    async () => {
      if (!deps.signals) throw new ToolError("NOT_IMPLEMENTED", "find_signals has no data source configured");
      const signal = await deps.signals();
      return {
        ...signal,
        next_step: "If a segment converts much better, consider propose_test on a placement those users see.",
      };
    },
  );

  // propose_test: the closed loop. The agent proposes a NEW test; Fulcrum checks policy and queues it for a
  // human. Nothing is created until a human approves; then Fulcrum creates a draft only; a human starts it in Adapty.
  tool(
    "propose_test",
    "Propose a new A/B test on a placement (Fulcrum only ever creates it as a draft; starting it is a human decision in Adapty): two flow ids (control first, challenger second), the challenger's traffic share in percent, an audience (all or a segment id) and a hypothesis. Fulcrum sets the declared goal itself (60-day revenue per install, rpi_60d, 15 planned looks), so later verdicts judge the test on it. Fulcrum checks fulcrum.policy.json (allowed placement, traffic cap, no live test there, daily write limit) and only a policy approver can approve at the approval page. There is no approve tool. Use placement and flow ids or names from Adapty; blocked replies cite the policy rule, pending ones say to poll request_status.",
    {
      placement: z.string().min(1),
      flows: z.tuple([z.string().min(1), z.string().min(1)]),
      challenger_weight: z.number().int().min(1).max(99).default(50),
      audience: z.string().regex(/^(all|[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/, 'audience must be "all" or a segment id'),
      hypothesis: z.string().min(1).max(500),
    },
    async (a) => {
      if (!deps.proposals || !cli.listPlacements || !cli.listFlows) throw new ToolError("NOT_IMPLEMENTED", "propose_test cannot look up placements and flows here");
      const [placements, flows] = await Promise.all([cli.listPlacements(), cli.listFlows()]);
      const placement = placements.find((p) => p.id === a.placement || p.developerId === a.placement);
      if (!placement) {
        throw new ToolError("UNKNOWN_PLACEMENT", `no placement ${a.placement}; known: ${placements.map((p) => p.developerId).join(", ")}`);
      }
      const [flowA, flowB] = a.flows.map((ref) => {
        const f = flows.find((x) => x.id === ref || x.name === ref);
        if (!f) throw new ToolError("UNKNOWN_FLOW", `no flow ${ref}; known: ${flows.map((x) => `${x.name} (${x.id})`).join(", ")}`);
        return f;
      }) as [(typeof flows)[number], (typeof flows)[number]];
      if (flowA.id === flowB.id) throw new ToolError("INVALID_FLOWS", "a test needs two different flows");

      const r = await deps.proposals.requestProposal({
        placement,
        flows: [
          { flowId: flowA.id, flowName: flowA.name },
          { flowId: flowB.id, flowName: flowB.name },
        ],
        challengerWeight: a.challenger_weight,
        audience: a.audience === "all" ? "all" : { segmentId: a.audience },
        hypothesis: a.hypothesis,
        title: `${placement.title}: ${flowA.name} vs ${flowB.name}`,
      });
      if (r.code === "DUPLICATE_PENDING") {
        if (r.policyRule === "in_progress") {
          return { action_id: r.actionId, status: "blocked", policy_rule: "request_in_progress", reason: "request in progress, retry propose_test in a moment" };
        }
        throw new ToolError("DUPLICATE_PENDING", `action ${r.actionId} is already pending for this placement; poll request_status with it`);
      }
      return {
        action_id: r.actionId,
        status: r.status,
        ...(r.policyRule ? { policy_rule: r.policyRule } : {}),
        reason:
          r.status === "pending"
            ? `Next: a human must approve at ${approvalUrl}; poll request_status with action_id ${r.actionId}. ${r.reason}`
            : r.reason,
        ...(r.policyPassed
          ? { policy_check: { file: "fulcrum.policy.json", passed: r.policyPassed, approvers: r.approvers ?? [] } }
          : {}),
        ...(r.notes.length > 0 ? { existing_draft: r.notes } : {}),
        creates: "a draft only: after approval Fulcrum runs ab-tests create once; starting the test stays a human action in Adapty, and Fulcrum has no start tool",
        declared_goal: { metric: GOAL_METRIC, horizon_days: HORIZON_DAYS, K: GOAL_K },
      };
    },
  );

  // request_status: lets the agent poll whether the human approved. It is read-only, it can't approve.
  tool("request_status", "Check the status of a stop or test request. pending: keep polling; executed: done (a proposed test is a draft, a human starts it in Adapty); failed: do not retry, tell the human; blocked or expired: ask judge_test (stops) or propose_test again if still warranted.", { action_id: z.string() }, async (a) => {
    if (deps.proposals?.has(a.action_id)) {
      const v = deps.proposals.status(a.action_id);
      return {
        action_id: v.actionId,
        kind: "propose_test",
        status: v.status,
        reason: v.reason,
        ...(v.createdTestId !== undefined ? { created_test_id: v.createdTestId } : {}),
        ...(v.policyRule !== undefined ? { policy_rule: v.policyRule } : {}),
        ...(v.approvedBy !== undefined ? { approved_by: v.approvedBy } : {}),
        ...(v.executedAt !== undefined ? { executed_at: v.executedAt } : {}),
        ...(v.cliExit !== undefined ? { cli_result: { exit: v.cliExit } } : {}),
      };
    }
    let v;
    try {
      v = gate.status(a.action_id);
    } catch {
      throw new ToolError("UNKNOWN_ACTION", `no action with id ${a.action_id}`);
    }
    return {
      action_id: v.actionId,
      status: v.status,
      reason: v.reason,
      ...(v.approvedBy !== undefined ? { approved_by: v.approvedBy } : {}),
      ...(v.executedAt !== undefined ? { executed_at: v.executedAt } : {}),
      ...(v.cliExit !== undefined ? { cli_result: { exit: v.cliExit } } : {}),
    };
  });
}
