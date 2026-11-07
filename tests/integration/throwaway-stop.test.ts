import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdaptyCli } from "../../src/adapty/cli.js";
import { createLedger } from "../../src/gate/ledger.js";
import { createGate, type Judge } from "../../src/gate/pending.js";

const testId = process.env.THROWAWAY_TEST_ID ?? "";
const APP_ID = "f8711513-c780-42b2-b6da-6c44094f3867"; // Lumen hackathon app (not a secret)

// Manual only: performs a real write to Adapty. Skipped unless explicitly enabled.
describe.skipIf(process.env.ALLOW_WRITES !== "1" || !process.env.THROWAWAY_TEST_ID)(
  "live throwaway stop",
  () => {
    it("AC-4 live stop of a throwaway test through the gate", async () => {
      process.loadEnvFile(".env");
      const token = process.env.ADAPTY_TOKEN;
      if (!token) throw new Error("ADAPTY_TOKEN is missing from .env");
      const cli = createAdaptyCli({ appId: process.env.ADAPTY_APP_ID ?? APP_ID, token });

      // Safety check before anything else.
      const before = await cli.getTest(testId);
      if (before.state !== "live" || /^(Onboarding|Main)/.test(before.title)) {
        throw new Error("refusing: not a throwaway test");
      }
      const arm = before.arms[0];
      if (!arm) throw new Error("test has no arms");

      const judge: Judge = async () => ({
        verdict: "WINNER",
        winnerArmId: arm.armId,
        reasons: ["throwaway rehearsal"],
      });

      const dir = mkdtempSync(join(tmpdir(), "fulcrum-live-"));
      try {
        const ledger = createLedger(join(dir, "ledger.jsonl"));
        const gate = createGate({ cli, ledger, judge });

        const req = await gate.requestStop({
          testId,
          winnerArmId: arm.armId,
          metric: "arpu",
          rationale: "throwaway rehearsal",
        });
        expect(req.status).toBe("pending");

        const done = await gate.approve(req.actionId, "djordje");
        expect(done.status).toBe("executed");

        const after = await cli.getTest(testId);
        expect(after.state).toBe("completed");

        expect(
          ledger
            .all()
            .some((e) => e.id === req.actionId && e.tool === "execute_stop" && e.status === "executed"),
        ).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
