import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  appId: string;
  token: string;
  dataDir: string | undefined;
  ledgerPath: string;
  port: number;
}

const DEFAULT_APP_ID = "f8711513-c780-42b2-b6da-6c44094f3867";

// src/config.ts -> repo root. The MCP server may be started with any cwd (the demo agent runs in demo/).
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(repoRoot: string = REPO_ROOT): Config {
  const envFile = join(repoRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const token = process.env.ADAPTY_TOKEN;
  if (!token) {
    throw new Error("ADAPTY_TOKEN is not set. Put it in .env (see .env.example); Fulcrum is the only process that holds it.");
  }
  const port = Number(process.env.FULCRUM_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("FULCRUM_PORT must be an integer between 1 and 65535");
  }
  return {
    appId: process.env.ADAPTY_APP_ID || DEFAULT_APP_ID,
    token,
    dataDir: process.env.OFFLINE_DATA_DIR || undefined,
    ledgerPath: process.env.FULCRUM_LEDGER_PATH || join(repoRoot, ".fulcrum", "ledger.jsonl"),
    port,
  };
}
