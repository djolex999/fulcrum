# Fulcrum: project instructions

Team Fulcrum (Djordje, Milica Petković) at the Adapty Hackathon Belgrade, 7 to 8 Nov 2026.

## Event rules (hard)

- No application code before kickoff (Sat 7 Nov, 10:10). Before that: docs, config and personal tooling only.
- Commits: none before kickoff. From kickoff on, Claude may commit without asking after each logical change (see Working conventions). This exception applies only to sessions in this repo during the hackathon (7 to 8 Nov 2026); everywhere else the normal "commit only when asked" rule stands. Push only when Djordje asks.
- Never copy anything from `~/Projects/adapty-seed-data-hack` into this repo (no data, no scripts).
- Never write secrets anywhere. No API keys in files, logs, commits or chat.
- Code freeze: **Sun 8 Nov, 15:00**.
- Demo: 5 min + 3 min Q&A. Judged on business value and result, not code quality. Optimize for a working, convincing demo.

## Adapty

- App: "Lumen - AI Photo Editor (Hackathon)", app id `f8711513-c780-42b2-b6da-6c44094f3867`.
- Credentials only via `.env`: `ADAPTY_TOKEN` (CLI auth token, overrides the stored `adapty auth login` token) and `ANTHROPIC_API_KEY`. Never read, print or copy `.env`. New keys go in `.env.example` with empty values.
- Offline data lives at `~/Projects/adapty-seed-data-hack/data/offline/`. Read it in place by absolute path; never copy it into the repo.

### Known CLI facts

- Adapty CLI version 0.18.0.
- `flows publish` works.
- A stopped A/B test cannot be restarted. Treat `ab-tests stop` as irreversible.
- Verify flags with `--help` before using any command; do not guess flags.
- **Never run `adapty ab-tests stop` on the Onboarding or Main tests**, except in the live demo, and then only by Djordje. (Denied in `.claude/settings.json`.)

## Core invariant

Any tool that writes to Adapty creates a **pending action** that only executes after human approval in the UI. Never bypass it: no direct write path, no "auto-approve" flag, no test shortcut that skips the gate.

## Stack

- Next.js, TypeScript strict (no `any`): UI and agent.
- Python + pandas script for stats, writes JSON that the Next.js side reads.
- Ledger: JSON file or SQLite. No Supabase.

## Planned shape (decide after kickoff)

Nothing here is built. Confirm or change it once the kickoff brief is out.

- **What it is:** a guard layer between AI agents and Adapty. Agents can read everything; every change passes a statistical check and a human approval before Fulcrum executes it through the Adapty CLI (auth via `ADAPTY_TOKEN`).
- **Money:** the stopping boundary works both ways. It blocks fake winners (Settings test, p = 0.067) and lets real winners ship weeks earlier (Onboarding). Adapty takes a share of customer revenue, so wrong test decisions cost Adapty too.
- **Pitch line:** "A seatbelt for AI agents on your monetization stack."
- **Demo flow:**
  1. The agent asks to stop Settings and promote its winner; Fulcrum blocks it and shows the reason.
  2. The agent proposes closing Onboarding; the check passes, a human approves, and Fulcrum runs the CLI stop live.
- **Key number (compute at the event from the offline CSV):** the week the Onboarding test first crosses the boundary, and the extra revenue from shipping the winner at that week instead of leaving the test running.
- **Fallback if the kickoff brief changes direction:** Edit-5 Router. Users with 5+ AI edits on day one get an attribute and a segment, with a test on `ai_limit_reached`.

### Architecture (decided in review)

- The agent gets **only the Fulcrum MCP server**. It never sees the Adapty MCP server or the raw CLI.
- **Fulcrum is the only process that holds `ADAPTY_TOKEN`.** The token never enters the agent's context, and no log prints a command that contains it.
- Reads go through a CLI wrapper with a fixed set of calls (`ab-tests list` / `get` / `metrics`, `analytics`), not a passthrough of all 77 Adapty tools.
- Writes go through the approval gate (see Core invariant) and the audit ledger.
- **If this is not done by Sunday:** say openly in the demo that the deny list in `.claude/settings.json` is a client-side policy, and that in production Fulcrum would hold the token.

### Verdict rules

- **Judge only on the test's declared goal metric**, parsed from its goal text. Block "metric shopping". Example: Settings looks like a clear win on payer rate (z ≈ 5.3), but its goal is revenue, so payer rate does not count.
- **The horizon comes from the goal.** Onboarding's goal is 60-day revenue per install, so the first valid look is week 9.
- **K (planned number of looks) and the horizon are parameters** from the test plan, with a visible fallback when the plan does not say. No hardcoded 15.
- **Boundary:** O'Brien-Fleming style, `c × sqrt(K/k)` at look k, with c calibrated by simulation to about 5% false wins (c ≈ 2.1 for K = 15).

### Time travel

- An `as_of` parameter replays the offline CSV as of a past date.
- **Demo centerpiece:** Settings as of 2 Sep (about 50% of users). The other arm leads by +$2.48 with p ≈ 0.049, so a naive agent would ship it. Fulcrum blocks it because the boundary at that look is about 2.9. By D90 the difference has shrunk to about +$0.09.

### Data source label

Every number shown carries its source: `adapty_metrics` (about 1,000 users as of today) or `export_csv` (50,000 users).

### Audit ledger

Record every write attempt, blocked or approved, with the reason, timestamp and who approved it.

### Money numbers for the pitch (re-verify in code at the event)

- Onboarding clears the boundary in week 9; shipping the winner then is worth about **$21k more** on Lumen.
- **Do not claim $50k.**

### Demo staging

- Run the Settings block live.
- Send the Onboarding request 2 minutes before the demo so the approval card is already waiting.
- Have a second screen already open on the test page, with `adapty ab-tests get --json` as proof that the stop happened.
- Record a backup video on Saturday evening, after the first end-to-end run.
- Rehearse stops only on a throwaway test, never on Onboarding or Main.

### Exit criterion

If the kickoff brief excludes agents or asks for a consumer feature, switch to the Edit-5 Router fallback by **11:30**.

### Cut order if behind

- The approval UI can be one plain HTML page.
- Skip polish before skipping time travel.

## Build phases (cut from the end)

Each phase ends at a stop point. Stop and confirm before starting the next.

1. Adapty CLI wrapper + approval gate + stop on a throwaway test (never Onboarding/Main).
2. Stats + 3 verdicts.
3. Agent with Claude tool use.
4. Hypothesis -> cloned flow variant -> publish -> new test.
5. Replay with group sequential (O'Brien-Fleming) stopping boundaries.

If time runs short, drop phases from the end, not from the middle.

Implement against SPEC.md. A phase is done when its AC tests pass. Log closed ACs in AI_LOG.md.

**After each phase, run the `phase-checkpoint` skill** before moving on. Before the demo, run `demo-preflight`.

Every phase ends with phase-checkpoint, which writes the AI_LOG.md entry.

## Working conventions

1. **Commits:** from kickoff on, small and meaningful all weekend: one logical change per commit, with a clear message. Never one big commit at the end. The repo is public and the organizers follow progress. In this repo's sessions, Claude commits without asking after each logical change that works (typecheck/tests pass where they exist). Never commit `.env`, `SECURITY-NOTES.md` or anything from `adapty-seed-data-hack`.
2. **README grows during the event.** By the demo it has: the problem, an architecture diagram (mermaid), a one-command run, and an honest **Limitations** section (synthetic data, what does not work, what is next).
3. **Required test:** a simulation that runs thousands of A/A tests through the boundary and asserts that the false-win rate is about 5%, and that naive weekly peeking gives about 20% or more. Keep it short and readable.
4. **Friction log:** whenever Djordje or Claude hits something slow, confusing or broken in the Adapty CLI, MCP, API or dashboard, append one line to `FRICTION.md` (date | surface | what happened | suggestion).
5. **Security findings never go in the public repo.** They go in `SECURITY-NOTES.md`, which is gitignored, and get reported to Adapty privately, not on stage.
