import { execFile } from "node:child_process";
import { redactSecrets } from "../safety/secrets.js";
import type { AbTestDetail, AbTestState, AbTestSummary, ApprovedStop } from "./types.js";

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
  // The token lives only in the child env: no argv, no inherited process.env.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ADAPTY_TOKEN: opts.token,
  };

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

  async function stopTest(action: ApprovedStop): Promise<AbTestDetail> {
    await exec([
      "ab-tests", "stop", action.abTestId,
      "--app", opts.appId,
      "--winner", action.winnerArmId,
      "-y", "--json",
    ]);
    return getTest(action.abTestId);
  }

  return { listTests, getTest, stopTest };
}

export type AdaptyCli = ReturnType<typeof createAdaptyCli>;
