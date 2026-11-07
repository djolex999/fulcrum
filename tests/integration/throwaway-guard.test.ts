import { describe, expect, it } from "vitest";
import { isThrowawayTest } from "./throwaway-guard.js";

const ok = { state: "live", title: "Throwaway rehearsal", placementTitle: "Throwaway placement" };

describe("isThrowawayTest", () => {
  it("accepts a live throwaway test", () => {
    expect(isThrowawayTest(ok)).toBe(true);
  });
  it.each([
    ["onboarding title", { ...ok, title: "onboarding x" }],
    ["leading-space main", { ...ok, title: " Main x" }],
    ["MAIN throwaway", { ...ok, title: "MAIN throwaway" }],
    ["onboarding placement", { ...ok, placementTitle: "Onboarding" }],
    ["completed state", { ...ok, state: "completed" }],
    ["no throwaway marker", { ...ok, title: "Paywall test" }],
  ])("refuses %s", (_n, t) => {
    expect(isThrowawayTest(t)).toBe(false);
  });
});
