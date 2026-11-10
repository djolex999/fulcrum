// `npm run demo:story`: prints the evidence behind the pitch on one screen. Offline only: reads the
// CSV export and test-plans.json, no Adapty CLI, no token. `--json` prints the raw Story instead.
import { loadDataset } from "../src/data/csv.js";
import { buildStory } from "../src/demo/story.js";
import type { Story, StoryLook } from "../src/demo/story.js";
import { fallbackKOf, loadPolicy } from "../src/policy/policy.js";
import { loadPlans } from "../src/stats/plans.js";

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const f2 = (x: number | null): string => (x === null ? "-" : x.toFixed(2));
const pad = (s: string | number, w: number): string => String(s).padStart(w);

function lookRow(l: StoryLook, marked: boolean): string {
  const cells = [
    pad(l.k, 4),
    pad(l.date, 11),
    pad(`${l.nA}/${l.nB}`, 9),
    pad(f2(l.z), 6),
    pad(f2(l.boundary), 9),
    pad(l.pNaive === null ? "-" : l.pNaive.toFixed(3), 8),
    pad(l.crossed ? "yes" : "no", 8),
  ];
  return `${marked ? ">>" : "  "} ${cells.join(" ")}${marked ? "  <== 16 Aug" : ""}`;
}

function render(s: Story): string {
  const st = s.settings;
  const m = st.marked.look;
  const o = s.onboarding;
  const out: string[] = [];
  out.push(`1. SETTINGS: THE PEEKING TRAP (goal ${st.goalMetric}, ${st.test.split(":")[0]}, weekly looks)`);
  out.push(`   ${pad("look", 4)} ${pad("ends", 11)} ${pad("n/arm", 9)} ${pad("z", 6)} ${pad("boundary", 9)} ${pad("naive p", 8)} ${pad("crossed", 8)}`);
  for (const l of st.looks) out.push(lookRow(l, l.k === m.k));
  out.push("");
  out.push(
    `   16 Aug: naive p ${m.pNaive === null ? "-" : m.pNaive.toFixed(3)} -> a peeking agent ships \`${st.marked.shippedByPeeker}\`; z ${f2(m.z)} is below the boundary ${f2(m.boundary)} -> Fulcrum blocks.`,
  );
  out.push(
    `   Last planned look (${st.lastLook.k}): ${st.lastLook.verdict === "WINNER" ? "winner" : "no winner"}, p ${f2(st.lastLook.pNaive)}. End of data: ${st.end.leader} ahead (p ${f2(st.end.pNaive)}).`,
  );
  out.push("");
  out.push(`2. WHY THE BOUNDARY: SIMULATION (${s.simulation.sims.toLocaleString("en-US")} A/A tests, K = ${s.simulation.K}, seed ${s.simulation.seed})`);
  out.push(`   Weekly peeking at p < 0.05: ${pct(s.simulation.naive)} false winners.`);
  out.push(`   Fulcrum boundary (c = ${s.simulation.c}): ${pct(s.simulation.boundary)} false winners.`);
  out.push("");
  out.push(`3. ONBOARDING: THE DECISION TIMELINE (goal ${o.goalMetric})`);
  const next = o.notYet.nextLookDate === null ? "" : ` Next look: ${o.notYet.nextLookDate}.`;
  out.push(`   Week 2 (${o.notYet.asOf}): NOT YET (${o.notYet.code ?? "no code"}).${next}`);
  out.push(`   Week ${o.now.k} (${o.now.date}): NOW. z ${f2(o.now.z)} vs boundary ${f2(o.now.boundary)}, winner \`${o.now.winnerArm}\`.`);
  const k = Math.round(o.moneyUsd / 1000);
  out.push(
    `   Shipping at week ${o.now.k} instead of leaving it running: about $${k}k (age-curve estimate; an independent matched-cohort check gave $17.5k).`,
  );
  out.push("");
  out.push("All numbers: export_csv (synthetic Lumen data), declared goals from test-plans.json.");
  return out.join("\n");
}

const data = await loadDataset();
const story = buildStory(data, loadPlans(undefined, data), fallbackKOf(loadPolicy()));
console.log(process.argv.includes("--json") ? JSON.stringify(story, null, 2) : render(story));
