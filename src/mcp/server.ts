import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdaptyCli } from "../adapty/cli.js";
import { loadConfig } from "../config.js";
import { createLedger } from "../gate/ledger.js";
import { createGate } from "../gate/pending.js";
import { startApprovalPage } from "../ui/approve.js";
import { createLogger } from "./log.js";
import { loadDataset } from "../data/csv.js";
import { loadPlans } from "../stats/plans.js";
import { createEngine } from "./engine.js";
import { registerTools, type ToolDeps } from "./tools.js";

export function buildServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "fulcrum", version: "0.1.0" });
  registerTools(server, deps);
  return server;
}

type Gate = ReturnType<typeof createGate>;

export async function main(opts: { startApprovalPage?: (gate: Gate, port: number) => void } = {}): Promise<void> {
  const config = loadConfig();
  const { log, scrub } = createLogger(config.token);
  const cli = createAdaptyCli({ appId: config.appId, token: config.token });
  const ledger = createLedger(config.ledgerPath);
  // One engine, one judge: the gate and the tools share it so they cannot disagree.
  const plans = loadPlans();
  const { judge, timeline } = createEngine({ cli, plans, loadData: () => loadDataset(config.dataDir) });
  const gate = createGate({ cli, ledger, judge });
  const server = buildServer({ cli, gate, judge, timeline, plans, log, scrub });
  // The human approval page: the only path to approve a write. Injectable for tests.
  const startPage = opts.startApprovalPage ?? ((g: Gate, p: number) => startApprovalPage(g, p, ledger, log));
  startPage(gate, config.port);
  await server.connect(new StdioServerTransport());
  log("Fulcrum MCP server ready on stdio");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    // loadConfig errors never contain values; scrub anyway.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fulcrum] fatal: ${createLogger("").scrub(msg)}\n`);
    process.exit(1);
  });
}
