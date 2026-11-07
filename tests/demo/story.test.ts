import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DATA_DIR, loadDataset } from "../../src/data/csv.js";
import { buildStory } from "../../src/demo/story.js";
import type { Story } from "../../src/demo/story.js";
import { loadPlans } from "../../src/stats/plans.js";

const real = existsSync(DEFAULT_DATA_DIR);

describe.skipIf(!real)("DEMO-STORY", () => {
  let story: Story;
  beforeAll(async () => {
    const data = await loadDataset();
    story = buildStory(data, loadPlans(undefined, data));
  });

  it("DEMO-STORY marks 16 Aug with naive p < 0.05 and z below the boundary", () => {
    const m = story.settings.marked.look;
    expect(m.date).toBe("2026-08-16");
    expect(m.pNaive).not.toBeNull();
    expect(m.pNaive as number).toBeLessThan(0.05);
    expect(Math.abs(m.z as number)).toBeLessThan(m.boundary);
    expect(m.crossed).toBe(false);
    expect(story.settings.looks.some((l) => l.crossed)).toBe(false);
  });

  it("DEMO-STORY simulation shows naive > 20% and boundary near 5%", () => {
    expect(story.simulation.naive).toBeGreaterThan(0.2);
    expect(story.simulation.boundary).toBeGreaterThan(0.035);
    expect(story.simulation.boundary).toBeLessThan(0.065);
  });

  it("DEMO-STORY onboarding not yet at week 2 and winner at week 9, money between 16k and 23k", () => {
    const o = story.onboarding;
    expect(o.notYet.code).toBe("BEFORE_HORIZON");
    expect(o.notYet.nextLookDate).not.toBeNull();
    expect(o.now.k).toBe(9);
    expect(o.now.z).toBeGreaterThanOrEqual(o.now.boundary);
    expect(o.moneyUsd).toBeGreaterThan(16_000);
    expect(o.moneyUsd).toBeLessThan(23_000);
  });
});
