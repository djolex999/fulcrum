# Fulcrum spec

> **DRAFT.** Nothing here is built yet. The design and the demo story are in [docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md](docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md). Numbers marked ≈ come from analysis and independent re-computation, and get re-verified by the tests.

## Goal, user, non-goals

- **Goal:** help subscription apps make more money by stopping A/B test decisions that are wrong: shipping fake winners, and leaving real winners in a test for weeks.
- **User:** a growth lead who lets AI agents run paywall and onboarding tests in Adapty, and wants them fast but unable to fool themselves.
- **Non-goals:** a new dashboard or analytics product; Bayesian/P2BB replacement; multi-app or multi-tenant auth; real user data; auto-approval of any kind.

## Verdict rules

1. **Goal metric only.** Each test's declared goal (metric, horizon, K) comes from the checked-in test plan file `test-plans.json`, shown as `goal_source: "test_plan"`, because Adapty does not store a machine-readable goal metric. Onboarding: 60-day revenue per install. Settings: revenue per install to date. A request on any other metric is refused as metric shopping.
2. **RPI** = net revenue (refunds subtracted at refund time) within the horizon, over all installs that have the full horizon (to date: all installs up to the cutoff); z is Welch on per-user values; look k ends at the first install + 7k days.
3. **Horizon from the goal.** A goal of "60-day revenue per install" means only users installed ≥ 60 days before the look count, so Onboarding's first valid look is week 9. Earlier looks return `BEFORE_HORIZON`.
4. **K and horizon are parameters** from the test plan. If the plan does not give K, use the fallback (K = 15 weekly looks) and return `K_source: "fallback"` so it is visible.
5. **Boundary:** at look k of K, a winner needs `|z| ≥ c × sqrt(K/k)`, with c calibrated by A/A simulation to ≈ 5% false wins (c ≈ 2.1 for K = 15).
6. **Three verdicts:** `WINNER` (boundary crossed on the goal metric at a valid look), `CONTINUE` (not crossed, looks remain), `NO_WINNER` (last look reached, not crossed).
7. **`as_of` replay:** recompute any verdict as of a past date from the offline CSV only.
8. **Source label** on every number: `adapty_metrics` (live, ≈ 1,000 users) or `export_csv` (offline, 50,000 users).

## MCP tool contracts (Fulcrum server)

The agent gets only these tools. There is no approve tool: approval happens only in the human UI.

| Tool | Input | Output | Errors |
|---|---|---|---|
| `list_tests` | `{}` | `[{test_id, title, state, placement, goal_metric, horizon_days}]` | `ADAPTY_UNAVAILABLE` |
| `judge_test` | `{test_id, as_of?: date, metric?: string}` | `{verdict, goal_metric, look_k, K, K_source, horizon_days, z, boundary, effect, p_naive, arms[], source, reasons[]}` | `UNKNOWN_TEST`, `METRIC_NOT_GOAL`, `BEFORE_HORIZON`, `INVALID_AS_OF`, `AS_OF_REQUIRES_CSV` |
| `test_timeline` | `{test_id, metric?: string}` | `{goal_metric, K, K_source, looks: [{k, date, z, boundary, crossed, leader, p_naive}], first_crossing?: {k, date, arm}, end: {leader, effect, p_naive}, source}` | `UNKNOWN_TEST`, `METRIC_NOT_GOAL` |
| `request_stop` | `{test_id, winner_arm_id, metric, rationale, as_of?: date}` | `{action_id, status: "blocked" \| "pending", verdict, reason}` | `UNKNOWN_TEST`, `NOT_LIVE`, `UNKNOWN_ARM`, `DUPLICATE_PENDING` |
| `request_status` | `{action_id}` | `{action_id, status: blocked \| pending \| approved \| rejected \| executed \| failed, approved_by?, executed_at?, cli_result?}` | `UNKNOWN_ACTION` |

- `request_stop` runs `judge_test` itself. It returns `blocked` unless the verdict is `WINNER` on the goal metric for that arm. With `as_of` (replay) it only ever returns the verdict and a ledger entry, never a pending action: a past date can't be executed.
- For a completed test, `request_stop` returns `NOT_LIVE`, and `judge_test` / `test_timeline` still explain whether the declared winner was supported.
- Asking again after a block, or rephrasing, re-runs the same check: the result only changes if the data changes.
- After approval Fulcrum runs `adapty ab-tests stop <id> --app <app> --winner <arm> --yes --json`, then confirms with `adapty ab-tests get --json`.

## Approval gate invariants

1. **No write without approval.** Every write is a pending action; only a human click in the UI moves it to `approved`; only `approved` actions execute, once.
2. **Token only in the Fulcrum process.** `ADAPTY_TOKEN` comes from `.env`, is passed to the CLI through the environment, and never appears in tool output, error messages, ledger entries or logs.
3. **Audit ledger.** Every write attempt, blocked or approved, is appended with `{id, ts, tool, test_id, args, verdict, status, reason, approved_by, cli_exit}`. Entries are never edited or deleted.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Settings (declared winner `settings` in Adapty): `test_timeline` on the goal metric shows **no look where the boundary is crossed in `settings`' favour**, and at the end `main_lifetime` leads (≈ −$1.57 RPI, p ≈ 0.067). `judge_test` reports the declared winner as not supported. |
| AC-2 | Onboarding on 60-day revenue per install: `request_stop` with `as_of` at week 2 returns `blocked` with `BEFORE_HORIZON` ("not yet"); the first valid look is week 9, where the boundary is crossed (z ≈ 4.5 vs ≈ 2.71) and the verdict is `WINNER` for weekly first ("now"). |
| AC-3 | A request on a metric that is not the declared goal is refused with `METRIC_NOT_GOAL`. Examples: Settings with `metric: "rpi_30d"` (the one look, 16 Aug, where `settings` looked naively significant, p ≈ 0.044) and with `metric: "payer_rate"`. |
| AC-4 | A stop with no approval never runs the CLI; an approved action runs it exactly once; a rejected one never. |
| AC-5 | The token value never appears in any tool output, error, ledger entry or log line. |
| AC-6 | 2,000+ simulated A/A tests through the boundary give 5% ± 1.5% false wins; naive weekly peeking at p < 0.05 gives ≥ 20% (≈ 22.5% with 15 looks). |
| AC-7 | Every `request_stop`, blocked or pending, adds exactly one ledger entry with a reason; approval adds `approved_by` and a timestamp. |
| AC-8 | Every number in `judge_test` carries `source`; `as_of` with `adapty_metrics` returns `AS_OF_REQUIRES_CSV`. |
| AC-9 | With no K in the test plan, `judge_test` returns `K_source: "fallback"`; with K given, it uses that K and the boundary changes. |
| AC-10 | Repeating a blocked request with the same data returns `blocked` again, with no new pending action. |
| AC-11 | The money number: the extra revenue from shipping Onboarding's winner at its first crossing, computed by the implementation, lands within 15% of the independent re-computation (≈ $19.4k). |
| AC-12 | The demo agent's MCP config contains only the Fulcrum server, and the agent's environment has no `ADAPTY_TOKEN`. |

## Test plan (write after kickoff; each test is named with its AC id)

All tests use Vitest (TypeScript). Stats tests read the offline CSV in place via `OFFLINE_DATA_DIR`; gate and MCP tests mock the CLI. Tests that write to Adapty run only with `ALLOW_WRITES=1`, set by a human.

| AC | Test |
|---|---|
| AC-1 | `AC-1 Settings boundary never crossed for the declared winner`, `AC-1 Settings declared winner is not supported at the end` |
| AC-2 | `AC-2 Onboarding stop at week 2 is blocked as BEFORE_HORIZON`, `AC-2 Onboarding is WINNER at week 9 on 60-day revenue` |
| AC-3 | `AC-3 request_stop on non-goal metric returns METRIC_NOT_GOAL` |
| AC-4 | `AC-4 pending action never calls the CLI`, `AC-4 approved action calls the CLI once`, `AC-4 rejected action never calls the CLI` |
| AC-5 | `AC-5 token absent from outputs, errors, ledger and logs` |
| AC-6 | `AC-6 boundary false-win rate is about 5%`, `AC-6 naive peeking false-win rate is at least 20%` |
| AC-7 | `AC-7 every request_stop writes one ledger entry` |
| AC-8 | `AC-8 every number has a source label`, `AC-8 as_of with adapty_metrics is rejected` |
| AC-9 | `AC-9 fallback K is visible`, `AC-9 K from the plan changes the boundary` |
| AC-10 | `AC-10 repeated blocked request stays blocked, no new pending action` |
| AC-11 | `AC-11 Onboarding extra revenue is within 15% of the independent check` |
| AC-12 | `AC-12 demo agent config has only the Fulcrum server and no token` |
