const FORBIDDEN_PREFIXES = ["onboarding", "main"];

/** Fail-closed: only a live test explicitly marked "throwaway" qualifies. */
export function isThrowawayTest(t: { state: string; title: string; placementTitle: string }): boolean {
  const title = t.title.trim().toLowerCase();
  const placement = t.placementTitle.trim().toLowerCase();
  if (t.state !== "live") return false;
  if (!title.includes("throwaway")) return false;
  return !FORBIDDEN_PREFIXES.some((p) => title.startsWith(p) || placement.startsWith(p));
}
