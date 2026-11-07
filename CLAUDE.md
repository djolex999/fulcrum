# Fulcrum: project instructions

Team Fulcrum (Djordje, Milica Petković) at the Adapty Hackathon Belgrade, 7 to 8 Nov 2026.

## Event rules (hard)

- No application code before kickoff (Sat 7 Nov, 10:10). Before that: docs, config and personal tooling only.
- Commits: none before kickoff. From kickoff on, Claude may commit without asking after each logical change (see Working conventions). This exception applies only to sessions in this repo during the hackathon (7 to 8 Nov 2026); everywhere else the normal "commit only when asked" rule stands. Push only when Djordje asks.
- Never copy anything from `~/Projects/adapty-seed-data-hack` into this repo (no data, no scripts).
- Never write secrets anywhere. No API keys in files, logs, commits or chat.
- Code freeze: **Sun 8 Nov, 15:00**.
- Demo: 5 min + 3 min Q&A. **Judging criteria:** (1) AI-native engineering, (2) ideas and product thinking, (3) implementation quality. The challenge: make subscription apps make more money.
- **Deliverables:** the public repo, the submission form at code freeze, a 2-minute unlisted YouTube video (uploaded before Sun 13:00), the AI log, and the live demo.
- **Detailed private context:** `CLAUDE.local.md` (local only, never committed). If it and this file disagree, `CLAUDE.local.md` is newer.

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
- Deny rules match the literal command, so `npm test` could run CLI writes internally. **Integration tests that write to Adapty run only with `ALLOW_WRITES=1`, which Djordje sets himself. Never set it automatically.**
- Fulcrum calls Adapty through the CLI, not through Adapty's MCP.

## Core invariant

Any tool that writes to Adapty creates a **pending action** that only executes after human approval in the UI. Never bypass it: no direct write path, no "auto-approve" flag, no test shortcut that skips the gate.

## Stack

TypeScript strict (no `any`), ESM, Node 22, Vitest. One language everywhere. Minimal dependencies: official `@modelcontextprotocol/sdk` (stdio), Hono for the approval page. Ledger: JSON file or SQLite. No Supabase, no Python.

```
src/mcp/server.ts        Fulcrum MCP server: list_tests, judge_test, request_stop, request_status
src/adapty/cli.ts        execFile wrapper, always --json, token from env, reads and writes separated, never logs the token
src/data/csv.ts          offline CSV loader, path from OFFLINE_DATA_DIR
src/stats/rpi.ts         revenue per install by arm and horizon
src/stats/boundary.ts    c * sqrt(K/k) and its calibration simulation
src/stats/verdict.ts     verdict on the declared goal only, horizon, as_of replay, source label
src/gate/pending.ts      pending write actions (nothing executes without approval)
src/gate/ledger.ts       audit ledger: every write attempt, blocked or approved, reason, time, approver
src/ui/approve.ts        Hono server: one page with pending actions, Approve and Reject
tests/                   one or more tests per acceptance criterion, named with its AC id
```

## Planned shape (decide after kickoff)

Nothing here is built. Confirm or change it once the kickoff brief is out.

- **What it is:** AI agents run paywall experiments that make subscription apps more money, without fooling themselves. Fulcrum is an MCP server between the agent and Adapty: the agent reads test data through Fulcrum's fixed read calls and has no direct write path; every write passes a statistical check and a human approval before Fulcrum executes it through the Adapty CLI (auth via `ADAPTY_TOKEN`).
- **Why AI:** the statistics are plain deterministic code. The AI part is the agent doing growth work (finding the next hypothesis, proposing tests, explaining verdicts); Fulcrum is what makes that safe. This is the weakest judge question, so answer it honestly.
- **Money:** the stopping boundary works both ways. It blocks fake winners (Settings: p ≈ 0.049 as of 2 Sep, p = 0.067 and z = 1.83 at the end) and lets real winners ship weeks earlier (Onboarding). Adapty takes a share of customer revenue, so wrong test decisions cost Adapty too.
- **Pitch line:** "A seatbelt for AI agents on your monetization stack."
- **Demo flow:**
  1. Settings **as of 2 Sep** (time travel): a naive agent would ship it; Fulcrum blocks it and shows the reason, then fast-forward to D90 to show the gap vanished. (At the end state even a plain t-test blocks it, so the end state alone proves nothing.)
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

1. CLI wrapper, approval gate, stop on a throwaway test (never Onboarding/Main). Target ~13:30.
2. Stats, boundary, verdicts, `as_of` replay, declared-goal rule. Target ~16:00.
3. Fulcrum MCP tools wired to the agent, approval page, audit ledger, end-to-end demo flow. Target 18:00.
4. Optional: the agent finds the next hypothesis (Edit-5 signal) and proposes a new test through Fulcrum.
5. Polish, README, video, rehearsal.

If a test shows a different number than the spec or `CLAUDE.local.md`, fix the spec and the context file, not the code.

**Independent review:** before key commits, spawn a fresh reviewer subagent that sees only the diff and SPEC.md, not the conversation. It answers: can the agent bypass the gate, can the token leak, is the boundary right. A second fresh subagent re-computes the pitch numbers from the CSV alone. Reviewers never get `.env` or Adapty access. Log each review in AI_LOG.md.

**Automatic checks:** a pre-commit hook blocks secrets and a failing `tsc --noEmit` or failing tests (set it up in phase 1).

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
