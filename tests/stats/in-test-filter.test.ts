import { describe, expect, it } from "vitest";
import type { Dataset, Txn, User } from "../../src/data/csv.js";
import type { TestPlan } from "../../src/stats/plans.js";
import { judgeTest } from "../../src/stats/verdict.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

const plan: TestPlan = { title: "T", arms: ["a", "b"], goal: "rpi", horizonDays: null, K: 15 };

// In-test users: 10 per arm, mean revenue 3 (arm a) vs 6 (arm b).
// Bystanders: same flows, different ab_test value, revenue 1000 each. They must not count.
function build(): Dataset {
  const users: User[] = [];
  const txns: Txn[] = [];
  const add = (id: string, flow: string, abTest: string, revenue: number): void => {
    users.push({ userId: id, installAt: new Date(T0 + DAY), flow, abTest, aiEditsFirstDay: 0 });
    txns.push({ userId: id, purchasedAt: new Date(T0 + 2 * DAY), priceUsd: revenue, refundedAt: null });
  };
  for (let i = 0; i < 10; i++) {
    add(`a${i}`, "a", "T", i % 2 === 0 ? 2 : 4);
    add(`b${i}`, "b", "T", i % 2 === 0 ? 5 : 7);
    add(`xa${i}`, "a", "other", 1000 + i);
    add(`xb${i}`, "b", "other", 1000 + i);
  }
  return { users, txns, dataEnd: new Date(T0 + 30 * DAY) };
}

describe("verdict uses only users inside the test", () => {
  it("arm n and rpi ignore users on the same flows with a different ab_test", () => {
    const v = judgeTest(plan, build(), { asOf: new Date(T0 + 15 * DAY) });
    expect(v.arms).toEqual([
      { arm: "a", n: 10, rpi: 3 },
      { arm: "b", n: 10, rpi: 6 },
    ]);
    expect(v.effect).toBeCloseTo(3, 10);
  });
});
