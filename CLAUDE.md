# Fulcrum: project instructions

Team Fulcrum (Djordje, Milica Petković) at the Adapty Hackathon Belgrade, 7 to 8 Nov 2026.

> **Positioning:** Fulcrum is the only door between AI agents and an Adapty account. Agents can read everything. Every change goes through Fulcrum: policy, statistics, human approval, then Fulcrum executes. It lets agents safely make apps more money.
>
> **Pitch:** "Adapty just gave AI agents the keys. Fulcrum is the only door."
>
> **Not our lane:** another team builds a human-facing experiment judge (dashboard, health checks, approval before stop, an agent skill). We do **not** build dashboards or test health checks. Our edge is enforced agent isolation, peeking and metric-shopping protection, a closed loop to new tests, and policy as code.

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

## Planned shape

Nothing here is built yet. **The demo design is in [docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md](docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md)**; SPEC.md holds the contracts and ACs.

- **What it is:** the only door between AI agents and Adapty. Fulcrum is an MCP server: the agent reads through Fulcrum and has no direct write path (Adapty MCP write tools and CLI writes are denied for it); every change (stop a test, start a new one) passes policy, statistics and a human approval, then Fulcrum executes it through the Adapty CLI (auth via `ADAPTY_TOKEN`, held only by Fulcrum).
- **Why AI:** the statistics are plain deterministic code. The AI part is the agent doing growth work (finding the next hypothesis, proposing tests, explaining verdicts); Fulcrum is what makes that safe. This is the weakest judge question, so answer it honestly.
- **Money:** the stopping boundary works both ways. It blocks fake winners (Settings: the declared winner `settings` never crossed the boundary and ends behind, p = 0.067, z = 1.83) and lets real winners ship weeks earlier (Onboarding, week 9). Adapty takes a share of customer revenue, so wrong test decisions cost Adapty too.
- **Pitch line:** "Adapty just gave AI agents the keys. Fulcrum is the only door."
- **The moment to remember:** the agent tries Adapty's own stop tool and is denied; through Fulcrum it is told "not yet" (peeking) or "no" (metric shopping), and when the evidence allows, a human approves and Fulcrum stops the test live. Then the agent proposes a new test, and it goes through the same door.
- **The agent:** real Claude Code in a demo folder whose MCP config has **only** the Fulcrum server (Adapty plugin off, no CLI, no token). The "naive" moment is the real agent following a hurried human's instruction.
- **Demo flow:** see `CLAUDE.local.md` section 8 (private). In short: hook (agents have write access and they peek), direct Adapty stop denied, Settings time travel blocked by the boundary and then for metric shopping, Onboarding live stop after approval, the agent proposes a new test on `ai_limit_reached` (5+ AI edits signal), how we built it.
- **Peeking date:** the 2 Sep Settings scene does not hold (p = 0.26 in two independent checks). The only naive-significant `settings` look on its test-plan goal (30-day RPI) is **16 Aug** (p ≈ 0.044, boundary ≈ 3.3). It is fragile (permutation p = 0.052): AC-PEEK pins the implementation's own number, and the pitch says "a weekly-peeking agent would have shipped it here", nothing stronger.
- **Closed loop (was the fallback):** the agent finds that users with 5+ AI edits on day one pay about twice as often and calls `propose_test` for a new test on `ai_limit_reached`; Fulcrum checks policy and queues it for approval.

### Architecture (decided in review)

- The agent gets **only the Fulcrum MCP server**. It never sees the Adapty MCP server or the raw CLI.
- **Fulcrum is the only process that holds `ADAPTY_TOKEN`.** The token never enters the agent's context, and no log prints a command that contains it.
- Reads go through a CLI wrapper with a fixed set of calls (`ab-tests list` / `get` / `metrics`, `analytics`), not a passthrough of all 77 Adapty tools.
- Writes go through the approval gate (see Core invariant) and the audit ledger.
- **If this is not done by Sunday:** say openly in the demo that the deny list in `.claude/settings.json` is a client-side policy, and that in production Fulcrum would hold the token.

### Verdict rules

- **Judge only on the test's declared goal metric**, from the checked-in test plan file (`goal_source: "test_plan"`). Block "metric shopping": a request on any other metric (for example Settings on 30-day RPI or payer rate) is refused.
- **The horizon comes from the goal.** Onboarding's goal is 60-day revenue per install, so the first valid look is week 9.
- **K (planned number of looks) and the horizon are parameters** from the test plan, with a visible fallback when the plan does not say. No hardcoded 15.
- **Boundary:** O'Brien-Fleming style, `c × sqrt(K/k)` at look k, with c calibrated by simulation to about 5% false wins (c ≈ 2.1 for K = 15).

### Time travel

- An `as_of` parameter replays the offline CSV as of a past date; `test_timeline` replays every weekly look.
- **Demo use:** Onboarding at week 2 ("not yet") and week 9 ("now"), and the full Settings timeline. Replays never create a pending action.

### Data source label

Every number shown carries its source: `adapty_metrics` (about 1,000 users as of today) or `export_csv` (50,000 users).

### Audit ledger

Record every write attempt, blocked or approved, with the reason, timestamp and who approved it.

### Money numbers for the pitch (re-verify in code at the event)

- Onboarding: "not yet" at week 2 (no user has 60 days), first crossing at **week 9** (z ≈ 4.3 vs boundary 2.71, day-aligned looks; two independent checks agree on week 9).
- Money: shipping at week 9 is worth **about $19k** (implementation $19.4k, independent matched-cohort check $17.5k; real uncertainty ±25%). **Never say $19,409.86, $50k or $21k.**
- Settings 16 Aug (AC-PEEK): z 2.0 vs boundary 3.3; naive p **just under 0.05** that day (0.045; a permutation test gives 0.050; a day either side 0.07). Say "an agent peeking that day would have shipped it; the boundary was 3.3, so Fulcrum blocks regardless". Never "0.044, significant".
- Simulation (AC-CALIB): naive weekly peeking **over 20% (≈ 22%)** false winners, boundary **about 5%**.

### Demo staging

- Run the Onboarding "not yet" replay and the Settings timeline live.
- Send the Onboarding request 2 minutes before the demo so the approval card is already waiting.
- Have a second screen already open on the test page, with `adapty ab-tests get --json` as proof that the stop happened.
- Record a backup video on Saturday evening, after the first end-to-end run.
- Rehearse stops only on a throwaway test, never on Onboarding or Main.

### Exit criterion

Passed (the brief fits agents). The Edit-5 signal is now part of the closed loop (AC-LOOP), not a fallback.

### Cut order if behind

- The approval UI is one plain HTML page. No dashboards, no test health checks.
- Cut from the end of the build order. **Never cut AC-BYPASS, AC-TOKEN or AC-CALIB.**
- The backup video, README and rehearsal are mandatory.

## Build phases (cut from the end)

Each phase ends at a stop point. Stop and confirm before starting the next.

1. MCP server, token isolation, approval gate, throwaway-test stop, bypass denial (AC-BYPASS, AC-TOKEN). The CLI wrapper, gate and ledger are already built (plan tasks 1–4).
2. Verdict: declared goal, horizon, boundary, `as_of` replay, metric shopping (AC-PEEK, AC-SHOP, AC-CALIB).
3. Closed loop: `propose_test` through the gate (AC-LOOP).
4. Policy file `fulcrum.policy.yaml` (AC-POLICY), if time allows.
5. Demo script, README, video, rehearsal.

Cut from the end. **Never cut AC-BYPASS, AC-TOKEN or AC-CALIB.**

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
