import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdaptyCli } from "../../src/adapty/cli.js";
import { createLedger } from "../../src/gate/ledger.js";
import { createProposals } from "../../src/gate/proposals.js";

const APP_ID = "f8711513-c780-42b2-b6da-6c44094f3867"; // Lumen hackathon app (not a secret)
const placementId = process.env.THROWAWAY_PLACEMENT_ID ?? "";
const FORBIDDEN = ["onboarding", "main"];

// Manual only: performs a real write to Adapty (a DRAFT test; nothing goes live). Skipped unless
// Djordje sets ALLOW_WRITES=1 and THROWAWAY_PLACEMENT_ID himself. Run it with a placement that has no live test.
describe.skipIf(process.env.ALLOW_WRITES !== "1" || !placementId)("live throwaway create (draft only)", () => {
  it("AC-LOOP live create of a draft through the proposal queue", async () => {
    process.loadEnvFile(".env");
    const token = process.env.ADAPTY_TOKEN;
    if (!token) throw new Error("ADAPTY_TOKEN is missing from .env");
    const cli = createAdaptyCli({ appId: process.env.ADAPTY_APP_ID ?? APP_ID, token });

    const placement = (await cli.listPlacements()).find((p) => p.id === placementId);
    if (!placement) throw new Error("placement not found");
    if (FORBIDDEN.some((f) => placement.developerId.toLowerCase().startsWith(f))) throw new Error("refusing: not a throwaway placement");
    const flows = (await cli.listFlows()).slice(0, 2);
    const [a, b] = flows;
    if (!a || !b) throw new Error("need two flows");

    const dir = mkdtempSync(join(tmpdir(), "fulcrum-live-"));
    const ledger = createLedger(join(dir, "ledger.jsonl"));
    const proposals = createProposals({
      cli,
      ledger,
      policy: { ok: true, policy: { approvers: ["djordje"], allowedPlacements: [placement.developerId], maxChallengerWeight: 50, fallbackK: 15, fallbackHorizonDays: null, dailyWriteLimit: 5 } },
    });
    try {
      const req = await proposals.requestProposal({
        placement,
        flows: [{ flowId: a.id, flowName: a.name }, { flowId: b.id, flowName: b.name }],
        challengerWeight: 50,
        audience: "all",
        hypothesis: "throwaway rehearsal",
        title: `throwaway ${placement.title}`,
      });
      expect(req.status).toBe("pending");
      const done = await proposals.approve(req.actionId, "djordje");
      expect(done.status).toBe("executed");
      const created = await cli.getTest(done.createdTestId ?? "");
      expect(created.state).toBe("draft");
    } catch (err) {
      console.error(`live test failed; ledger kept at ${join(dir, "ledger.jsonl")}`);
      throw err;
    }
  }, 120_000);
});
