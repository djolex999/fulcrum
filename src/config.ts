import { existsSync } from "node:fs";

export interface Config {
  appId: string;
  token: string;
  dataDir: string | undefined;
  ledgerPath: string;
  port: number;
}

const DEFAULT_APP_ID = "f8711513-c780-42b2-b6da-6c44094f3867";

export function loadConfig(): Config {
  if (existsSync(".env")) process.loadEnvFile(".env");
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
    ledgerPath: process.env.FULCRUM_LEDGER_PATH || ".fulcrum/ledger.jsonl",
    port,
  };
}
