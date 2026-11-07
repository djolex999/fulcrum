// The only wrapper around the `adapty` CLI. The Adapty token must exist only inside this
// process. It is handed to the CLI through the child's environment, never in argv (visible in
// `ps`), never inherited, and anything that comes back is redacted before it can reach a log, error or the agent.

import { execFile } from "node:child_process";
import { redactSecrets } from "../safety/secrets.js";
import type { AbTestDetail, AbTestState, AbTestSummary, ApprovedCreate, ApprovedStop, Flow, Placement } from "./types.js";

export type Runner = (
  file: string,
  args: string[],
  env: Record<string, string>,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export class AdaptyCliError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "AdaptyCliError";
    this.code = code;
  }
}

// execFile runs the binary with an args array and no shell, so values can't be turned into shell commands.
// The env is passed explicitly: the child gets exactly what we give it and nothing from process.env.
export const defaultRunner: Runner = (file, args, env) =>
  new Promise((resolve) => {
    execFile(file, args, { env, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr, code: 0 });
      const code = typeof error.code === "number" ? error.code : 1;
      // spawn failures (ENOENT) have no stderr; surface the error text instead
      resolve({ stdout, stderr: stderr || error.message, code });
    });
  });

interface RawTest {
  ab_test_id: string;
  title: string;
  state: AbTestState;
  placement: { placement_id: string; title: string };
  flows?: { flow_id: string; flow_name: string }[];
}

function toSummary(t: RawTest): AbTestSummary {
  return {
    abTestId: t.ab_test_id,
    title: t.title,
    state: t.state,
    placementTitle: t.placement.title,
  };
}

function toDetail(t: RawTest): AbTestDetail {
  return {
    ...toSummary(t),
    arms: (t.flows ?? []).map((f) => ({ armId: f.flow_id, name: f.flow_name })),
  };
}

export function createAdaptyCli(opts: { appId: string; token: string; run?: Runner; bin?: string }) {
  const run = opts.run ?? defaultRunner;
  const bin = opts.bin ?? "adapty";
  // That is why the env is built by hand with just PATH, HOME and the token. Nothing else leaks to the child.
  // The token lives only in the child env: no argv, no inherited process.env.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ADAPTY_TOKEN: opts.token,
  };

  // CLI error text can echo the token (a bad-auth message, a debug line). Cut out the exact token
  // first, then run the general secret patterns, before the text goes into an Error.
  const redact = (text: string): string => {
    const withoutToken = opts.token ? text.split(opts.token).join("[REDACTED]") : text;
    return redactSecrets(withoutToken);
  };

  async function exec(args: string[]): Promise<string> {
    const result = await run(bin, args, env);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "no output";
      throw new AdaptyCliError(
        redact(`adapty ${args[0] ?? ""} ${args[1] ?? ""} failed (exit ${result.code}): ${detail}`),
        result.code,
      );
    }
    return result.stdout;
  }

  function parse<T>(stdout: string, what: string): T {
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new AdaptyCliError(`adapty ${what} returned non-JSON output`, 0);
    }
  }

  async function listTests(): Promise<AbTestSummary[]> {
    const out = await exec(["ab-tests", "list", "--app", opts.appId, "--json"]);
    return parse<{ data: RawTest[] }>(out, "ab-tests list").data.map(toSummary);
  }

  async function getTest(id: string): Promise<AbTestDetail> {
    const out = await exec(["ab-tests", "get", id, "--app", opts.appId, "--json"]);
    return toDetail(parse<RawTest>(out, "ab-tests get"));
  }

  // The only write. Its parameter type ApprovedStop can only be built by the gate after a human approval,
  // so no other code can compile a call to this. After stopping we re-read the test to confirm it.
  async function stopTest(action: ApprovedStop): Promise<AbTestDetail> {
    await exec([
      "ab-tests", "stop", action.abTestId,
      "--app", opts.appId,
      "--winner", action.winnerArmId,
      "-y", "--json",
    ]);
    return getTest(action.abTestId);
  }

  // Read-only lookups used to validate a proposal. Parsing is tolerant: a row missing an id is skipped
  // rather than guessed. Only the first page is read (the app has a handful of each).
  async function listPlacements(): Promise<Placement[]> {
    const out = await exec(["placements", "list", "--app", opts.appId, "--json"]);
    const rows = parse<{ data?: Record<string, unknown>[] }>(out, "placements list").data ?? [];
    return rows.flatMap((r) =>
      typeof r.id === "string" && typeof r.developer_id === "string"
        ? [{ id: r.id, developerId: r.developer_id, title: typeof r.title === "string" ? r.title : r.developer_id }]
        : [],
    );
  }

  async function listFlows(): Promise<Flow[]> {
    const out = await exec(["flows", "list", "--app", opts.appId, "--json"]);
    const rows = parse<{ data?: Record<string, unknown>[] }>(out, "flows list").data ?? [];
    return rows.flatMap((r) =>
      typeof r.id === "string" && typeof r.name === "string"
        ? [{ id: r.id, name: r.name, status: typeof r.status === "string" ? r.status : "unknown" }]
        : [],
    );
  }

  const audienceArgs = (a: ApprovedCreate): string[] =>
    a.audience === "all" ? ["--all-users"] : ["--segment", a.audience.segmentId];

  // The only create. Like stopTest, ApprovedCreate can only be built by the proposal queue after a human
  // approval. It creates a DRAFT (nothing goes live); starting it stays a human decision in Adapty. The id is read tolerantly from the response, and
  // if it can't be found we fail closed: starting something we cannot name is never an option.
  async function createTest(a: ApprovedCreate): Promise<{ abTestId: string }> {
    const flows = JSON.stringify(a.flows.map((f) => ({ flow_id: f.flowId, weight: f.weight, title: f.title })));
    const out = await exec([
      "ab-tests", "create",
      "--app", opts.appId,
      "--title", a.title,
      "--placement", a.placementId,
      "--flows", flows,
      "--goal", a.goal,
      ...audienceArgs(a),
      "--json",
    ]);
    const raw = parse<{ ab_test_id?: unknown; data?: { ab_test_id?: unknown } }>(out, "ab-tests create");
    const id = raw.ab_test_id ?? raw.data?.ab_test_id;
    if (typeof id !== "string" || id === "") {
      throw new AdaptyCliError("adapty ab-tests create succeeded but the response has no ab_test_id; check Adapty for a draft test", 0);
    }
    return { abTestId: id };
  }

  return { listTests, getTest, stopTest, listPlacements, listFlows, createTest };
}

export type AdaptyCli = ReturnType<typeof createAdaptyCli>;
