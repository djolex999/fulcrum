import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Backup for the live demo: the same tool calls the agent makes, sent over stdio.
// Never touches the approval page; a human still approves there.
const TEST_ID = process.env.DEMO_TEST_ID ?? "REPLACE_ME";
const ARM_ID = process.env.DEMO_ARM_ID ?? "REPLACE_ME";

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
