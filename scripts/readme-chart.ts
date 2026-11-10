// `npm run readme:chart`: draws the Settings peeking chart for the README from the same Story that
// `npm run demo:story` prints. Offline only: reads the CSV export and test-plans.json, no Adapty CLI,
// no token. Writes docs/img/peeking-light.svg and docs/img/peeking-dark.svg.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadDataset } from "../src/data/csv.js";
import { buildStory } from "../src/demo/story.js";
import type { StoryLook } from "../src/demo/story.js";
import { loadPlans } from "../src/stats/plans.js";

interface Theme {
  surface: string;
  text: string;
  muted: string;
  grid: string;
  z: string;
  bound: string;
}

// Categorical slots 1 and 2 of the reference palette (blue, orange), stepped per mode.
const LIGHT: Theme = { surface: "#fcfcfb", text: "#0b0b0b", muted: "#52514e", grid: "#e4e3df", z: "#2a78d6", bound: "#eb6834" };
const DARK: Theme = { surface: "#1a1a19", text: "#f0efec", muted: "#c3c2b7", grid: "#3a3a37", z: "#3987e5", bound: "#d95926" };

const W = 760;
const H = 400;
const M = { top: 64, right: 150, bottom: 44, left: 48 };
const Y_MAX = 4;
const NAIVE = 1.96;
const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (iso: string): string => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const f = (n: number): string => n.toFixed(1);

function render(looks: StoryLook[], marked: StoryLook, t: Theme): string {
  const first = looks[0];
  const last = looks[looks.length - 1];
  if (!first || !last || marked.z === null || marked.pNaive === null) throw new Error("story has no looks with data");
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (k: number): number => M.left + ((k - first.k) / (last.k - first.k)) * plotW;
  const y = (v: number): number => M.top + ((Y_MAX - v) / (2 * Y_MAX)) * plotH;
  const path = (pts: [number, number][]): string => pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${f(px)},${f(py)}`).join(" ");

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">`);
  out.push(`<title id="t">Settings test: a weekly peeker ships on 16 Aug, Fulcrum's boundary blocks</title>`);
  out.push(
    `<desc id="d">z per weekly look on the declared goal (30-day revenue per install). On 16 Aug z is ${marked.z.toFixed(2)}, past the naive 1.96 line (p ${marked.pNaive.toFixed(3)}) but under the boundary of ${marked.boundary.toFixed(2)}. Later the other arm leads.</desc>`,
  );
  out.push(`<rect width="${W}" height="${H}" rx="8" fill="${t.surface}"/>`);
  out.push(`<g ${FONT}>`);

  // Title and legend, one row each above the plot.
  out.push(`<text x="${M.left}" y="26" font-size="15" font-weight="600" fill="${t.text}">Settings test, weekly looks on the declared goal (30-day revenue per install)</text>`);
  const legend = [
    { label: "z (settings vs main_lifetime)", color: t.z, dash: "" },
    { label: "Fulcrum boundary", color: t.bound, dash: "" },
    { label: "naive p &lt; 0.05 (|z| 1.96)", color: t.muted, dash: ` stroke-dasharray="4 4"` },
  ];
  let lx = M.left;
  for (const l of legend) {
    out.push(`<line x1="${lx}" y1="44" x2="${lx + 18}" y2="44" stroke="${l.color}" stroke-width="2"${l.dash}/>`);
    out.push(`<text x="${lx + 24}" y="48" font-size="12" fill="${t.muted}">${l.label}</text>`);
    lx += 24 + l.label.replace("&lt;", "<").length * 6 + 22;
  }

  // Grid and axes: recessive.
  for (let v = -Y_MAX; v <= Y_MAX; v += 2) {
    out.push(`<line x1="${M.left}" y1="${f(y(v))}" x2="${W - M.right}" y2="${f(y(v))}" stroke="${t.grid}" stroke-width="1"/>`);
    out.push(`<text x="${M.left - 8}" y="${f(y(v) + 4)}" font-size="11" text-anchor="end" fill="${t.muted}">${v}</text>`);
  }
  for (const l of looks) {
    if ((l.k - first.k) % 2 !== 0 && l.k !== marked.k) continue;
    out.push(`<text x="${f(x(l.k))}" y="${H - M.bottom + 18}" font-size="11" text-anchor="middle" fill="${t.muted}">${short(l.date)}</text>`);
  }
  out.push(`<text x="${W - M.right}" y="${H - 8}" font-size="11" text-anchor="end" fill="${t.muted}">look ending (2026)</text>`);

  // Naive line and boundary, both sides.
  for (const s of [1, -1]) {
    out.push(`<line x1="${M.left}" y1="${f(y(s * NAIVE))}" x2="${W - M.right}" y2="${f(y(s * NAIVE))}" stroke="${t.muted}" stroke-width="1.5" stroke-dasharray="4 4"/>`);
    out.push(`<path d="${path(looks.map((l) => [x(l.k), y(s * l.boundary)]))}" fill="none" stroke="${t.bound}" stroke-width="2"/>`);
  }

  // z line, with markers.
  const zs = looks.filter((l): l is StoryLook & { z: number } => l.z !== null);
  out.push(`<path d="${path(zs.map((l) => [x(l.k), y(l.z)]))}" fill="none" stroke="${t.z}" stroke-width="2" stroke-linejoin="round"/>`);
  for (const l of zs) {
    const r = l.k === marked.k ? 5 : 3;
    out.push(`<circle cx="${f(x(l.k))}" cy="${f(y(l.z))}" r="${r}" fill="${t.z}" stroke="${t.surface}" stroke-width="2"/>`);
  }

  // Direct labels at the right edge.
  const end = (v: number): string => f(y(v) + 4);
  out.push(`<text x="${W - M.right + 8}" y="${end(last.boundary)}" font-size="12" fill="${t.text}">boundary ${last.boundary.toFixed(2)}</text>`);
  out.push(`<text x="${W - M.right + 8}" y="${end(NAIVE) }" dy="12" font-size="12" fill="${t.muted}">naive 1.96</text>`);
  if (last.z !== null) {
    out.push(`<text x="${W - M.right + 8}" y="${end(last.z)}" font-size="12" fill="${t.text}">main_lifetime</text>`);
    out.push(`<text x="${W - M.right + 8}" y="${end(last.z)}" dy="14" font-size="12" fill="${t.muted}">leads at the end</text>`);
  }

  // The annotation: the day a peeker ships.
  const mx = x(marked.k);
  const my = y(marked.z);
  out.push(`<line x1="${f(mx)}" y1="${f(my - 8)}" x2="${f(mx + 34)}" y2="${f(my - 52)}" stroke="${t.muted}" stroke-width="1"/>`);
  out.push(`<text x="${f(mx + 38)}" y="${f(my - 64)}" font-size="12" font-weight="600" fill="${t.text}">${short(marked.date)}: naive p ${marked.pNaive.toFixed(3)}, a peeker ships</text>`);
  out.push(`<text x="${f(mx + 38)}" y="${f(my - 48)}" font-size="12" fill="${t.muted}">z ${marked.z.toFixed(2)} &lt; boundary ${marked.boundary.toFixed(2)}: Fulcrum blocks</text>`);

  out.push(`</g></svg>`);
  return out.join("\n") + "\n";
}

const story = buildStory(await loadDataset(), loadPlans());
const looks = story.settings.looks.filter((l) => l.z !== null);
const dir = fileURLToPath(new URL("../docs/img/", import.meta.url));
mkdirSync(dir, { recursive: true });
for (const [name, theme] of [["light", LIGHT], ["dark", DARK]] as const) {
  writeFileSync(`${dir}peeking-${name}.svg`, render(looks, story.settings.marked.look, theme));
}
console.log(`wrote ${dir}peeking-light.svg and peeking-dark.svg`);
