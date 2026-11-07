import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AdaptyCliError, createAdaptyCli, type Runner } from "../../src/adapty/cli.js";
import type { ApprovedStop } from "../../src/adapty/types.js";

const detailFixture = JSON.parse(
  readFileSync(new URL("./fixtures/ab-test-get.json", import.meta.url), "utf8"),
) as { ab_test_id: string };

const APP = "f8711513-c780-42b2-b6da-6c44094f3867";
const TOKEN = "dev_live_SECRET123";

type Call = { file: string; args: string[]; env: Record<string, string> };

function fakeRunner(responses: Array<{ stdout?: string; stderr?: string; code?: number }>) {
  const calls: Call[] = [];
  const run: Runner = async (file, args, env) => {
    calls.push({ file, args, env });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)] ?? {};
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
  };
  return { run, calls };
}

const LIST_JSON = JSON.stringify({
  data: [
    {
      ab_test_id: "a1",
      title: "T",
      type: "flow",
      state: "live",
      placement: { placement_id: "p", title: "P" },
      segment_ids: [],
      priority: 0,
      started_at: null,
      stopped_at: null,
    },
  ],
  meta: {},
});

describe("createAdaptyCli", () => {
  it("AC-5 token is passed only through env", async () => {
    const { run, calls } = fakeRunner([{ stdout: LIST_JSON }]);
    await createAdaptyCli({ appId: APP, token: TOKEN, run }).listTests();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.args.some((a) => a.includes(TOKEN))).toBe(false);
      expect(c.env.ADAPTY_TOKEN).toBe(TOKEN);
      expect(Object.keys(c.env).sort()).toEqual(["ADAPTY_TOKEN", "HOME", "PATH"]);
    }
  });

  it("every call uses --json and --app", async () => {
    const { run, calls } = fakeRunner([{ stdout: LIST_JSON }, { stdout: JSON.stringify(detailFixture) }]);
    const cli = createAdaptyCli({ appId: APP, token: TOKEN, run });
    await cli.listTests();
    await cli.getTest("a1");
    for (const c of calls) {
      expect(c.args).toContain("--json");
      expect(c.args).toContain("--app");
      expect(c.args[c.args.indexOf("--app") + 1]).toBe(APP);
    }
  });

  it("AC-5 CLI error message is redacted", async () => {
    const { run } = fakeRunner([{ code: 1, stderr: "bad token dev_live_SECRET123" }]);
    const err = await createAdaptyCli({ appId: APP, token: TOKEN, run })
      .listTests()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdaptyCliError);
    expect((err as AdaptyCliError).message).not.toContain("dev_live_SECRET123");
    expect((err as AdaptyCliError).code).toBe(1);
  });

  it("redacts the token even when it matches no pattern", async () => {
    const { run } = fakeRunner([{ code: 2, stderr: "denied for opaque-token-value" }]);
    const err = await createAdaptyCli({ appId: APP, token: "opaque-token-value", run })
      .listTests()
      .catch((e: unknown) => e);
    expect((err as AdaptyCliError).message).not.toContain("opaque-token-value");
  });

  it("listTests maps {data, meta}", async () => {
    const { run } = fakeRunner([{ stdout: LIST_JSON }]);
    const tests = await createAdaptyCli({ appId: APP, token: TOKEN, run }).listTests();
    expect(tests).toEqual([{ abTestId: "a1", title: "T", state: "live", placementTitle: "P", placementId: "p" }]);
  });

  it("getTest maps flows to arms", async () => {
    const { run, calls } = fakeRunner([{ stdout: JSON.stringify(detailFixture) }]);
    const t = await createAdaptyCli({ appId: APP, token: TOKEN, run }).getTest(detailFixture.ab_test_id);
    expect(calls[0]?.args.slice(0, 3)).toEqual(["ab-tests", "get", detailFixture.ab_test_id]);
    expect(t.placementTitle).toBe("Main paywall");
    expect(t.arms).toEqual([
      { armId: "492ea5b8-5b36-4fd1-ab04-6bcafe47059f", name: "Main - 3 plans" },
      { armId: "304fc4e1-e0e3-44aa-8cfd-e846d8099eba", name: "Main - Lifetime anchor" },
    ]);
  });

  it("stopTest args", async () => {
    const { run, calls } = fakeRunner([{ stdout: "{}" }, { stdout: JSON.stringify(detailFixture) }]);
    const action = { abTestId: "a1", winnerArmId: "f1" } as unknown as ApprovedStop;
    const detail = await createAdaptyCli({ appId: APP, token: TOKEN, run }).stopTest(action);
    expect(calls[0]?.args).toEqual(["ab-tests", "stop", "a1", "--app", APP, "--winner", "f1", "-y", "--json"]);
    expect(calls[1]?.args.slice(0, 3)).toEqual(["ab-tests", "get", "a1"]);
    expect(detail.arms).toHaveLength(2);
  });
});
