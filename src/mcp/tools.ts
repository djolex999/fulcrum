// The tools the AI agent sees (MCP). Agent-centred on purpose: the agent can read tests, ask for
// a verdict, see the weekly timeline, ask to stop a test and poll the request status.
// There is NO approve tool. Approval only exists on the human web page (src/ui/approve.ts),
// so a prompt-injected or confused agent cannot approve its own request.
// Every tool result passes through one scrub function, so a secret can't leave through any tool.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdaptyCli } from "../adapty/cli.js";
import type { AbTestDetail } from "../adapty/types.js";
import { AdaptyCliError } from "../adapty/cli.js";
import type { createGate, Judge } from "../gate/pending.js";
import { goalMetricOf, type TestPlan } from "../stats/plans.js";
import { checkArmMapping, flowOfArm, planForTitle } from "./engine.js";
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
  cli: Pick<AdaptyCli, "listTests" | "getTest">;
  gate: Gate;
  judge: JudgeFn;
  timeline: TimelineFn;
  /** Test plans, joined to Adapty tests by title (list_tests goal and horizon; arm mapping check). */
  plans?: readonly TestPlan[];
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
  tool("list_tests", "List the app's Adapty A/B tests.", {}, async () => {
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
    "Judge whether a test has a statistically supported winner. as_of replays the verdict at a past date (csv source only).",
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
    "Weekly looks of a test against the sequential boundary.",
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
    "Ask to stop a live test with a declared winner. Fulcrum judges it first; a human must approve in the Fulcrum UI. There is no approve tool.",
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
      if (test.state !== "live") {
        throw new ToolError("NOT_LIVE", `test ${a.test_id} is ${test.state}, only live tests can be stopped`);
      }
      if (!test.arms.some((arm) => arm.armId === a.winner_arm_id)) {
        throw new ToolError("UNKNOWN_ARM", `arm ${a.winner_arm_id} is not part of test ${a.test_id}`);
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
      return {
        action_id: r.actionId,
        status: r.status,
        verdict: r.verdict,
        reason: r.reason,
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
                source: d.source,
              },
            }
          : {}),
      };
    },
  );

  // request_status: lets the agent poll whether the human approved. It is read-only, it can't approve.
  tool("request_status", "Check the status of a stop request.", { action_id: z.string() }, async (a) => {
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
