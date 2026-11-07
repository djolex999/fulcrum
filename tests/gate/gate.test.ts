import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdaptyCliError } from "../../src/adapty/cli.js";
import type { AbTestDetail, ApprovedStop } from "../../src/adapty/types.js";
import { createLedger } from "../../src/gate/ledger.js";
import { createGate, type Judge } from "../../src/gate/pending.js";

const DETAIL: AbTestDetail = {
  abTestId: "t1",
  title: "T",
  state: "completed",
  placementTitle: "P",
  arms: [{ armId: "a1", name: "A" }],
};

const winner: Judge = async () => ({ verdict: "WINNER", winnerArmId: "a1", reasons: ["clear win"] });
const cont: Judge = async () => ({ verdict: "CONTINUE", reasons: ["not enough data"] });
const REQ = { testId: "t1", winnerArmId: "a1", metric: "arpu", rationale: "ship it" };

let dir: string;
let calls: ApprovedStop[];
let stopImpl: (a: ApprovedStop) => Promise<AbTestDetail>;
let clock: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fulcrum-gate-"));
  calls = [];
  clock = new Date("2026-11-07T10:00:00Z");
  stopImpl = async () => DETAIL;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(judge: Judge) {
  const ledger = createLedger(join(dir, "ledger.jsonl"));
  const cli = {
    stopTest: async (a: ApprovedStop) => {
      calls.push(a);
      return stopImpl(a);
    },
  };
  const gate = createGate({ cli, ledger, judge, now: () => clock });
  return { gate, ledger };
}

describe("gate", () => {
  it("AC-4 pending action never calls the CLI", async () => {
    const { gate } = setup(winner);
    const r = await gate.requestStop(REQ);
    expect(r.status).toBe("pending");
    expect(gate.pending()).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("AC-4 approved action calls the CLI once", async () => {
    const { gate } = setup(winner);
    const { actionId } = await gate.requestStop(REQ);
    const first = await gate.approve(actionId, "djole");
    expect(first.status).toBe("executed");
    const second = await gate.approve(actionId, "djole");
    expect(second.status).toBe("executed");
    expect(second.reason).toBe("already executed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ abTestId: "t1", winnerArmId: "a1" });
  });

  it("concurrent approves execute once", async () => {
    const { gate } = setup(winner);
    const { actionId } = await gate.requestStop(REQ);
    await Promise.all([gate.approve(actionId, "djole"), gate.approve(actionId, "djole")]);
    expect(calls).toHaveLength(1);
    expect(gate.status(actionId).status).toBe("executed");
  });

  it("AC-4 rejected action never calls the CLI", async () => {
    const { gate } = setup(winner);
    const { actionId } = await gate.requestStop(REQ);
    expect(gate.reject(actionId, "djole").status).toBe("rejected");
    const after = await gate.approve(actionId, "djole");
    expect(after.status).toBe("rejected");
    expect(calls).toHaveLength(0);
    expect(gate.pending()).toHaveLength(0);
  });

  it("approval re-judges", async () => {
    let n = 0;
    const flip: Judge = async () => (n++ === 0 ? winner("t1", {}) : cont("t1", {}));
    const { gate } = setup(flip);
    const { actionId } = await gate.requestStop(REQ);
    const v = await gate.approve(actionId, "djole");
    expect(v.status).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("re-judge with a different winner arm blocks", async () => {
    let n = 0;
    const flip: Judge = async () =>
      n++ === 0 ? winner("t1", {}) : { verdict: "WINNER", winnerArmId: "a2", reasons: ["x"] };
    const { gate } = setup(flip);
    const { actionId } = await gate.requestStop(REQ);
    expect((await gate.approve(actionId, "djole")).status).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("request with a winner arm the judge did not pick is blocked", async () => {
    const { gate } = setup(winner);
    const r = await gate.requestStop({ ...REQ, winnerArmId: "other" });
    expect(r.status).toBe("blocked");
    expect(gate.pending()).toHaveLength(0);
  });

  it("pending expires after 30 minutes", async () => {
    const { gate } = setup(winner);
    const { actionId } = await gate.requestStop(REQ);
    clock = new Date(clock.getTime() + 31 * 60_000);
    const v = await gate.approve(actionId, "djole");
    expect(v.status).toBe("expired");
    expect(calls).toHaveLength(0);
    expect(gate.pending()).toHaveLength(0);
  });

  it("refuses an empty or whitespace approvedBy and stays pending", async () => {
    const { gate } = setup(winner);
    const { actionId } = await gate.requestStop(REQ);
    await expect(gate.approve(actionId, "")).rejects.toThrow();
    await expect(gate.approve(actionId, "   ")).rejects.toThrow();
    expect(gate.status(actionId).status).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  it("AC-7 every request_stop writes one ledger entry", async () => {
    const { gate, ledger } = setup(winner);
    const blocked = await gate.requestStop({ ...REQ, testId: "t2", asOf: new Date("2026-10-01T00:00:00Z") });
    const pend = await gate.requestStop(REQ);
    const entries = ledger.all();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.reason.length > 0)).toBe(true);
    expect(blocked.status).toBe("blocked");
    await gate.approve(pend.actionId, "djole");
    const approved = ledger.all().find((e) => e.status === "approved");
    expect(approved?.approvedBy).toBe("djole");
    expect(approved?.ts).toBeTruthy();
  });

  it("AC-10 repeated blocked request stays blocked, no new pending action", async () => {
    const { gate } = setup(cont);
    const a = await gate.requestStop(REQ);
    expect(a.status).toBe("blocked");
    expect(gate.pending()).toHaveLength(0);
    const b = await gate.requestStop(REQ);
    expect(b.status).toBe("blocked");
    expect(gate.pending()).toHaveLength(0);
  });

  it("asOf request never creates a pending action", async () => {
    const { gate } = setup(winner);
    const r = await gate.requestStop({ ...REQ, asOf: new Date("2026-10-01T00:00:00Z") });
    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("replay only");
    expect(r.verdict).toBe("WINNER");
    expect(gate.pending()).toHaveLength(0);
  });

  it("asOf replay carries the judge code and is never DUPLICATE_PENDING", async () => {
    const early: Judge = async () => ({ verdict: "CONTINUE", reasons: ["too early"], code: "BEFORE_HORIZON" });
    const { gate } = setup(early);
    const r = await gate.requestStop({ ...REQ, asOf: new Date("2026-10-01T00:00:00Z") });
    expect(r.status).toBe("blocked");
    expect(r.code).toBe("BEFORE_HORIZON");
    expect(r.verdict).toBe("CONTINUE");
    const { gate: g2 } = setup(winner);
    await g2.requestStop(REQ);
    const replay = await g2.requestStop({ ...REQ, asOf: new Date("2026-10-01T00:00:00Z") });
    expect(replay.code).toBeUndefined();
    expect(replay.status).toBe("blocked");
  });

  it("concurrent requestStop for one test: one pending, one DUPLICATE_PENDING, one CLI call", async () => {
    const slow: Judge = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { verdict: "WINNER", winnerArmId: "a1", reasons: ["ok"] };
    };
    const { gate } = setup(slow);
    const [x, y] = await Promise.all([gate.requestStop(REQ), gate.requestStop(REQ)]);
    expect([x.code, y.code].filter((c) => c === "DUPLICATE_PENDING")).toHaveLength(1);
    expect(gate.pending()).toHaveLength(1);
    await Promise.all([x, y].map((r) => gate.approve(r.actionId, "djole")));
    expect(calls).toHaveLength(1);
  });

  it("approve refuses when another action for the same test already executed", async () => {
    const { gate } = setup(winner);
    const a = await gate.requestStop(REQ);
    await gate.approve(a.actionId, "djole");
    const b = await gate.requestStop(REQ);
    expect(b.status).toBe("pending");
    const v = await gate.approve(b.actionId, "djole");
    expect(v.status).toBe("pending");
    expect(v.reason).toContain("refused");
    expect(calls).toHaveLength(1);
  });

  it("ledger append failure on request leaves no pending action", async () => {
    const ledger = {
      append: () => {
        throw new Error("disk full");
      },
      all: () => [],
    };
    const gate = createGate({ cli: { stopTest: async () => DETAIL }, ledger, judge: winner, now: () => clock });
    await expect(gate.requestStop(REQ)).rejects.toThrow("disk full");
    expect(gate.pending()).toHaveLength(0);
  });

  it("CLI failure marks failed, records cliExit, no retry", async () => {
    stopImpl = async () => {
      throw new AdaptyCliError("boom dev_liveABCDEFGH", 3);
    };
    const { gate, ledger } = setup(winner);
    const { actionId } = await gate.requestStop(REQ);
    const v = await gate.approve(actionId, "djole");
    expect(v.status).toBe("failed");
    expect(v.cliExit).toBe(3);
    expect(v.reason).toContain("stop call failed or could not be confirmed");
    expect(v.reason).not.toContain("dev_liveABCDEFGH");
    expect(ledger.all().some((e) => e.status === "failed" && e.cliExit === 3)).toBe(true);
    await gate.approve(actionId, "djole");
    expect(calls).toHaveLength(1);
  });

  it("a non-AdaptyCliError from stopTest also marks failed", async () => {
    stopImpl = async () => {
      throw new TypeError("cannot read arms");
    };
    const { gate } = setup(winner);
    const { actionId } = await gate.requestStop(REQ);
    const v = await gate.approve(actionId, "djole");
    expect(v.status).toBe("failed");
    expect(v.cliExit).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("DUPLICATE_PENDING", async () => {
    const { gate } = setup(winner);
    const first = await gate.requestStop(REQ);
    const second = await gate.requestStop(REQ);
    expect(second.code).toBe("DUPLICATE_PENDING");
    expect(second.actionId).toBe(first.actionId);
    expect(gate.pending()).toHaveLength(1);
  });

  it("an expired pending does not block a new request", async () => {
    const { gate } = setup(winner);
    const first = await gate.requestStop(REQ);
    clock = new Date(clock.getTime() + 31 * 60_000);
    const second = await gate.requestStop(REQ);
    expect(second.code).toBeUndefined();
    expect(second.status).toBe("pending");
    expect(second.actionId).not.toBe(first.actionId);
  });
});
