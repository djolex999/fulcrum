import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type ActionStatus =
  | "blocked"
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "failed"
  | "expired";

export interface LedgerEntry {
  id: string;
  ts: string;
  tool: string;
  testId: string;
  args: Record<string, unknown>;
  verdict: string;
  status: ActionStatus;
  reason: string;
  approvedBy?: string;
  cliExit?: number;
}

/** Append-only JSONL audit log. No update or delete API by design. */
export function createLedger(path: string) {
  mkdirSync(dirname(path), { recursive: true });

  function append(entry: LedgerEntry): void {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  function all(): LedgerEntry[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as LedgerEntry);
  }

  return { append, all };
}

export type Ledger = ReturnType<typeof createLedger>;
