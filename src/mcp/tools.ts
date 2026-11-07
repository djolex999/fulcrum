import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdaptyCli } from "../adapty/cli.js";
import type { AbTestDetail } from "../adapty/types.js";
import type { createGate, Judge } from "../gate/pending.js";

type Gate = ReturnType<typeof createGate>;

export type JudgeSource = "csv" | "adapty_metrics";

/** Full verdict engine output. The gate only needs the Judge subset. */
export type JudgeFn = (
  testId: string,
  opts: { asOf?: Date; metric?: string; source?: JudgeSource },
) => Promise<Awaited<ReturnType<Judge>> & Record<string, unknown>>;

export type TimelineFn = (testId: string, opts: { metric?: string }) => Promise<Record<string, unknown>>;

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

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
  log?: (message: string) => void;
  scrub?: (text: string) => string;
}

function parseAsOf(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : new Date(Number.NaN);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new ToolError("INVALID_AS_OF", "as_of must be a real calendar date, YYYY-MM-DD");
  }
  return d;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { cli, gate, judge, timeline } = deps;
  const log = deps.log ?? (() => {});
  const scrub = deps.scrub ?? ((s: string) => s);

  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: scrub(JSON.stringify(data)) }] });
  const fail = (code: string, message: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: scrub(JSON.stringify({ code, message })) }],
  });

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
        log(`${name} error ADAPTY_UNAVAILABLE: ${msg}`);
        return fail("ADAPTY_UNAVAILABLE", msg);
      }
    });
  }

  async function resolveTest(testId: string): Promise<AbTestDetail> {
    const list = await cli.listTests();
    if (!list.some((t) => t.abTestId === testId)) {
      throw new ToolError("UNKNOWN_TEST", `no A/B test with id ${testId}`);
    }
    return cli.getTest(testId);
  }

  tool("list_tests", "List the app's Adapty A/B tests.", {}, async () => {
    const tests = await cli.listTests();
    return {
      tests: tests.map((t) => ({
        test_id: t.abTestId,
        title: t.title,
        state: t.state,
        placement: t.placementTitle,
        goal_metric: null, // joined from the test plans in Task 9b
        horizon_days: null,
      })),
    };
  });

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

  tool(
    "test_timeline",
    "Weekly looks of a test against the sequential boundary.",
    { test_id: z.string(), metric: z.string().optional() },
    async (a) => {
      await resolveTest(a.test_id);
      return timeline(a.test_id, a.metric ? { metric: a.metric } : {});
    },
  );

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
      // Seam for Task 9b: map the Adapty arm id to its CSV flow here. For now the arm id passes through.
      if (!test.arms.some((arm) => arm.armId === a.winner_arm_id)) {
        throw new ToolError("UNKNOWN_ARM", `arm ${a.winner_arm_id} is not part of test ${a.test_id}`);
      }
      const r = await gate.requestStop({
        testId: a.test_id,
        winnerArmId: a.winner_arm_id,
        metric: a.metric,
        rationale: a.rationale,
        ...(asOf ? { asOf } : {}),
      });
      if (r.code === "DUPLICATE_PENDING") {
        if (r.verdict === "UNKNOWN") {
          return {
            action_id: r.actionId,
            status: "blocked",
            verdict: r.verdict,
            reason: "request in progress, re-check request_status",
          };
        }
        throw new ToolError("DUPLICATE_PENDING", `action ${r.actionId} is already pending for this test`);
      }
      return {
        action_id: r.actionId,
        status: r.status,
        verdict: r.verdict,
        reason: r.reason,
        ...(r.code ? { code: r.code } : {}),
      };
    },
  );

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
