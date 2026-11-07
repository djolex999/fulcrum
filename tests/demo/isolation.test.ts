import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { AbTestDetail } from "../../src/adapty/types.js";
import { createLedger } from "../../src/gate/ledger.js";
import { createGate, type Judge } from "../../src/gate/pending.js";
import { createLogger } from "../../src/mcp/log.js";
import { buildServer } from "../../src/mcp/server.js";
import { placeholderTimeline } from "../../src/mcp/tools.js";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

interface Settings {
  permissions: { deny: string[] };
  hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
}

describe("demo agent isolation", () => {
  it("AC-TOKEN AC-12 demo agent config holds no token", () => {
    const raw = read("demo/.mcp.json");
    const cfg = JSON.parse(raw) as { mcpServers: Record<string, { command: string; args: string[]; env?: unknown }> };
    expect(Object.keys(cfg.mcpServers)).toEqual(["fulcrum"]);
    const s = cfg.mcpServers.fulcrum;
    expect(s?.command).toBe("npx");
    expect(s?.args).toEqual(["tsx", "../src/mcp/server.ts"]);
    expect(s).not.toHaveProperty("env");
    expect(raw).not.toMatch(/TOKEN|KEY|SECRET/i);
  });

  it("AC-BYPASS demo config denies Adapty write tools and CLI writes", () => {
    const root = JSON.parse(read(".claude/settings.json")) as Settings;
    const demo = JSON.parse(read("demo/.claude/settings.json")) as Settings;
    const required = root.permissions.deny.filter(
      (d) => d.startsWith("mcp__plugin_adapty-skills_adapty__") || d.startsWith("Bash(adapty "),
    );
    expect(required.length).toBeGreaterThan(27);
    expect(required).toContain("mcp__plugin_adapty-skills_adapty__ab_tests_stop");
    expect(required).toContain("mcp__plugin_adapty-skills_adapty__apps_get");
    expect(required).toContain("Bash(adapty ab-tests stop:*)");
    for (const d of required) expect(demo.permissions.deny).toContain(d);
    expect(demo.permissions.deny).toContain("Read(../.env)");
    expect(demo.permissions.deny).toContain("Read(../.env.*)");

    const hook = demo.hooks.PreToolUse[0];
    expect(hook?.hooks[0]?.command).toBe('"$CLAUDE_PROJECT_DIR"/../.claude/hooks/guard.sh');
    for (const t of ["Bash", "Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"]) {
      expect(hook?.matcher.split("|")).toContain(t);
    }

    const guard = join(ROOT, ".claude/hooks/guard.sh");
    for (const command of ["adapty ab-tests stop X --app Y", "npx adapty@0.18.0 ab-tests stop X"]) {
      const out = spawnSync("bash", [guard], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        encoding: "utf8",
      }).stdout;
      expect(out).toContain('"permissionDecision": "deny"');
    }
  });

  it("AC-BYPASS the same stop through Fulcrum reaches the gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fulcrum-demo-"));
    try {
      const live: AbTestDetail = {
        abTestId: "t-live",
        title: "Settings",
        state: "live",
        placementTitle: "Settings",
        arms: [{ armId: "arm-a", name: "A" }, { armId: "arm-b", name: "B" }],
      };
      const cli = {
        listTests: async () => [{ abTestId: live.abTestId, title: live.title, state: live.state, placementTitle: live.placementTitle }],
        getTest: async () => live,
        stopTest: async () => live,
      };
      const judge: Judge = async () => ({ verdict: "WINNER", winnerArmId: "arm-a", reasons: ["ok"] });
      const ledger = createLedger(join(dir, "ledger.jsonl"));
      const gate = createGate({ cli, ledger, judge });
      const { log, scrub } = createLogger("unused-" + "value");
      const server = buildServer({ cli, gate, judge, timeline: placeholderTimeline, log, scrub });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      const res = await client.callTool({
        name: "request_stop",
        arguments: { test_id: "t-live", winner_arm_id: "arm-a", metric: "rpi", rationale: "ship it" },
      });
      expect(res.isError).not.toBe(true);
      const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n");
      expect(lines.map((l) => JSON.parse(l) as { tool?: string }).some((e) => e.tool === "request_stop")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
