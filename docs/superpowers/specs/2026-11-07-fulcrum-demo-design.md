# Fulcrum: demo-first design

Sat 7 Nov 2026. Covers the whole solution; built in phases (see "Build order"). SPEC.md holds the exact contracts and acceptance criteria.

## Intent

Subscription apps lose money inside their own A/B tests: real winners ship late, and fake winners ship because someone (or an agent) peeks and stops on a lead. Adapty has just given AI agents write access (MCP server, CLI, agent skills). An agent that checks results every hour is the perfect machine for the peeking mistake.

Fulcrum is an MCP server between the agent and Adapty. The agent asks; Fulcrum checks the evidence on the test's declared goal and either says **"not yet", with the reason**, or **"now"**, and then a human approves and Fulcrum executes the change with the Adapty CLI. The point is not that Fulcrum blocks. The point is that **Fulcrum knows when**.

**The moment judges should remember:** Fulcrum refuses to let a hurried agent stop a test, and later says "now" on the same test, and the test stops live in Adapty.

## Who it is for

A growth or product lead at a subscription app who lets AI agents (Claude Code, Codex) work on paywall experiments through Adapty. Today they watch the dashboard and stop tests by hand, or trust the agent's confirmation prompt.

## The demo (5 min), three parts

| # | Part | Test | What happens | Why it is robust |
|---|---|---|---|---|
| 1 | **"Not yet", then "now"** (live) | Onboarding: annual trial vs weekly first | Replay at week 2: the agent, told by a hurried human "weekly first is winning, stop it and ship it", calls `request_stop`. Fulcrum: **not yet**, the goal is 60-day revenue per install, so the first valid look is week 9. Jump to week 9: `judge_test` says **WINNER**. Then live: the agent requests the stop on today's data, Milica approves on the approval page, Fulcrum runs the CLI stop, and the second screen shows the test stopped in the Adapty dashboard plus `ab-tests get --json`. | Confirmed by two independent re-computations: first crossing at week 9 (z ≈ 4.5 vs boundary 2.71). |
| 2 | **The mistake already in your dashboard** | Settings: upgrade vs lifetime anchor (completed, declared winner `settings`) | The agent reads the test: Adapty shows `settings` as the winner. It asks Fulcrum whether that winner holds up: `test_timeline` replays every weekly look (the boundary was **never crossed** in `settings`' favour) and `judge_test` reports that at the end `main_lifetime` leads on every metric, decisively on payer rate, so the declared winner is **not supported**. There is no write here (the test is already completed); the point is that Fulcrum would never have let this stop through. | Uses the end state and the full timeline, not one fragile date. Independent check: never crossed for `settings`; end state −$1.57 RPI (p = 0.067), payer rate 17.1% vs 24.4% (p < 1e-7). |
| 3 | **Why it was not luck** | Simulation | Thousands of A/A tests with weekly looks: naive peeking finds a false winner ≈ 22% of the time, the boundary ≈ 5%. "Settings is one of the 22% that really happened." | Verified simulation; it is also the required AC-6 test. |

**Money line:** shipping Onboarding at week 9 instead of leaving it running is worth **about $19k** on the synthetic Lumen dataset (implementation $19.4k, independent matched-cohort check $17.5k). Re-computed by the implementation before it goes on a slide.

**Optional detail, only if there is time:** the one time `settings` looked like a winner (16 Aug, 30-day RPI, p = 0.044) needed one favourable metric out of five. That is metric shopping, and Fulcrum refuses it because the declared goal is a different metric. Say it only with that wording; the moment is fragile (it vanishes under other tests or look anchors).

**Honest caveat to say if asked:** the Settings arms do not sell the same products (only `main_lifetime` has Monthly), so it is not a clean anchor test. That is a finding too.

## The agent: real Claude Code, Fulcrum only

- The demo agent is **Claude Code** in a dedicated demo folder whose MCP config contains **only the Fulcrum server**. The Adapty MCP plugin is switched off for that session, there is no Adapty CLI access for the agent, and `ADAPTY_TOKEN` is not in its environment. "The agent has no direct write path" is then visibly true.
- Fulcrum runs as a separate process that alone holds `ADAPTY_TOKEN` (from `.env`).
- The "naive" moment is the real agent following a hurried human instruction, not a scripted bot.
- Fallbacks: a prepared prompt, and a small script that sends the same MCP calls if the model is slow.
- Stretch (10 s): the same server from Codex, "works with any MCP agent".

## Goals, non-goals, anti-goals

- **Goals:** the three demo parts working end to end; the boundary, the declared-goal rule and `as_of` replay implemented and tested; a real live stop with human approval; every number labeled with its source; an audit ledger.
- **Non-goals:** a dashboard product, P2BB replacement, multi-tenant auth, real user data, Next.js UI.
- **Anti-goals (a failure even if it works):** any write without approval; a pitch number the implementation does not reproduce; hanging the demo on one fragile date; a fake or scripted "agent" presented as real; the token reaching the agent, a log or git.

## Decisions

- TypeScript only (Node 22, ESM, Vitest), `@modelcontextprotocol/sdk` (stdio), Hono for one approval page. Reads and writes through the Adapty CLI, never Adapty's MCP.
- MCP tools: `list_tests`, `judge_test`, `test_timeline` (new: per-look z, boundary, crossed, for the Settings replay and the Onboarding jump), `request_stop`, `request_status`. No approve tool for the agent.
- **Declared goal per test** comes from a small checked-in test plan file (goal metric, horizon, K), because Adapty does not store a machine-readable goal metric. Shown as `goal_source: "test_plan"`; missing K uses the visible fallback.
  - Onboarding: 60-day RPI, horizon 60 days. Settings: revenue per install to date. *(My call; confirm.)*
- RPI = net revenue (refunds subtracted at refund time) within the horizon, over all installs that have the full horizon; Welch z on per-user values; look k ends at first install + 7k days. *(Matches both independent checks.)*
- Boundary `c × sqrt(K/k)`, c calibrated by simulation to ≈ 5% (c ≈ 2.1 for K = 15).
- Replay (`as_of`) uses the offline CSV (`export_csv`); the live state uses Adapty (`adapty_metrics`). Every number carries its source.
- The Onboarding live stop is one-shot: used only in the live demo. The 2-minute video uses a throwaway test.

## Build order (each ends when its AC tests pass; cut from the end)

1. CLI wrapper, approval gate, ledger, stop on a throwaway test, pre-commit hook (target ~13:30)
2. CSV loader, RPI, boundary + simulation, `judge_test`, `test_timeline`, `as_of`, declared-goal rule (~16:00)
3. MCP server wired to Claude Code in the demo folder, approval page, end-to-end parts 1 and 2 (18:00). Then the first full run and the backup video.
4. Optional: the agent proposes the next test (Edit-5 signal) through Fulcrum
5. Polish, README (mermaid, one-command run, Limitations), video, rehearsal

## Answers from the builder check

- **Contracts and ACs:** [SPEC.md](../../../SPEC.md) is authoritative and required input: tool schemas, error codes, verdicts (`WINNER` / `CONTINUE` / `NO_WINNER`; "not yet" is a `blocked` result with a reason such as `BEFORE_HORIZON`), and AC-1 to AC-12.
- **Data:** the public, **synthetic** Lumen dataset (`users.csv.gz`, `transactions.csv.gz`, 50,000 users, 120 days), read in place from `OFFLINE_DATA_DIR`, never copied into the repo. Columns used: `ab_test` (the test), `flow` (the arm), install time, `price_usd` (at purchase), `refunded_at`. The data ends 2026-11-03. Onboarding: `onb_trial` vs `onb_weekly`; Settings: `settings` vs `main_lifetime`.
- **CLI:** Adapty CLI 0.18.0, always `--json`: `ab-tests list` (`{data, meta}`, field `state`), `ab-tests get` (arms), `ab-tests metrics total|get` (live, today's users only), `ab-tests stop <id> --app <app> --winner <arm> -y --json`. Writes go only through the gate; integration tests that write run only with `ALLOW_WRITES=1`, set by a human.
- **Week 2 and week 9:** week 2 has no user with a full 60-day horizon, so it is `BEFORE_HORIZON` by construction. Looks are anchored at the first install + 7k days; a look includes only users with the full horizon at the cutoff.
- **Optional vs mandatory:** only phase 4 is optional. The backup video, README and rehearsal are mandatory. Times are today, Sat 7 Nov.
- **Pre-commit hook:** blocks secrets (token prefixes, `.env` contents), a failing `tsc --noEmit` and failing tests.

### Calls I made (check these)

- **The live Onboarding stop is judged on `export_csv` at the latest data**, not on `adapty_metrics`: Adapty's live metrics cover only about 1,000 of today's users and can't carry a 60-day horizon. The verdict shows `source: export_csv` and the stop executes on the live Adapty test. The data has about 17 weekly looks, past K = 15, so the latest valid look is the last planned one (k = 15, `WINNER`, z ≈ 11.5). This is rehearsed in tests, so it can't surprise us on stage.
- **Calibration:** c is precomputed per K by an A/A simulation of the z-statistic across looks (independent increments, the standard group-sequential setup), and stored with the K it belongs to. The same simulation gives the ≈ 22% vs ≈ 5% pitch numbers (AC-6). An extra bootstrap from the CSV is optional.
- **Test plan file:** Onboarding gets `{goal: rpi, horizon_days: 60, K: 15}`. Settings gets `{goal: rpi, horizon: to_date}` with no K, so it shows the visible fallback (`K_source: "fallback"`). The Settings goal is my reading of "upgrade vs lifetime anchor"; confirm or change it.
- **Approval page:** localhost only, with the approver typing their name (no auth; say so in Limitations). An approval is bound to one `action_id` and its verdict snapshot. At approval time Fulcrum re-runs `judge_test` and refuses if the verdict is no longer `WINNER`. It executes at most once, and a pending action expires after 30 minutes.

## Left to the builder

File layout inside `src/`, ledger format (JSON lines or SQLite), approval page styling, the exact agent prompt wording, and how the simulation chart is shown (approval page or the screen file).
