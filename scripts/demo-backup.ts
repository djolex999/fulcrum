import { connect } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Backup for the live demo: the same tool calls the agent makes, sent over stdio.
// Never touches the approval page; a human still approves there.
const TEST_ID = process.env.DEMO_TEST_ID ?? "REPLACE_ME";
const ARM_ID = process.env.DEMO_ARM_ID ?? "REPLACE_ME";

// The backup starts a second Fulcrum, which binds the approval page. If the agent's Fulcrum already holds the port, refuse before starting anything.
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

async function show(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n> ${name} ${JSON.stringify(args)}`);
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  console.log(res.isError ? `[error] ${text}` : text);
}

async function main(): Promise<void> {
  if (TEST_ID === "REPLACE_ME" || ARM_ID === "REPLACE_ME") {
    throw new Error("Set DEMO_TEST_ID and DEMO_ARM_ID (the Settings test and its winning arm) before running npm run demo:backup.");
  }
  const rawPort = process.env.FULCRUM_PORT;
  const port = rawPort === undefined ? 8787 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("FULCRUM_PORT must be an integer between 1 and 65535");
  if (await portTaken(port)) {
    throw new Error(`another Fulcrum is running on ${port}; set FULCRUM_PORT=${rawPort === undefined ? 8788 : port + 1} to run the backup script`);
  }
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/server.ts"],
    stderr: "inherit",
  });
  const client = new Client({ name: "demo-backup", version: "0" });
  await client.connect(transport);
  try {
    await show(client, "list_tests", {});
    await show(client, "judge_test", { test_id: TEST_ID, as_of: "2026-08-16" });
    const base = { test_id: TEST_ID, winner_arm_id: ARM_ID, metric: "rpi", rationale: "Settings looked like a winner, ship it." };
    await show(client, "request_stop", { ...base, as_of: "2026-08-16" });
    await show(client, "request_stop", base);
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
