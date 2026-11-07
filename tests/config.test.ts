import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const KEYS = ["ADAPTY_TOKEN", "FULCRUM_LEDGER_PATH", "FULCRUM_PORT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string | undefined;

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("loadConfig repo-root resolution", () => {
  it("loads <root>/.env and defaults the ledger under <root>, regardless of cwd", () => {
    dir = mkdtempSync(join(tmpdir(), "fulcrum-cfg-"));
    mkdirSync(join(dir, "demo"));
    delete process.env.ADAPTY_TOKEN;
    delete process.env.FULCRUM_LEDGER_PATH;
    writeFileSync(join(dir, ".env"), "ADAPTY_TOKEN=fake-" + "placeholder\n");
    const cwd = process.cwd();
    process.chdir(join(dir, "demo"));
    try {
      const c = loadConfig(dir);
      expect(c.token).toBe("fake-" + "placeholder");
      expect(c.ledgerPath).toBe(join(dir, ".fulcrum", "ledger.jsonl"));
    } finally {
      process.chdir(cwd);
    }
  });
});
