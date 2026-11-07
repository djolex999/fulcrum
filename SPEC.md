# Fulcrum spec

> **DRAFT, written before kickoff.** Nothing here is built. Confirm or change it after the kickoff brief. Numbers marked ≈ come from pre-event analysis and get re-verified in code.

## Goal, user, non-goals

- **Goal:** help subscription apps make more money by stopping A/B test decisions that are wrong: shipping fake winners, and leaving real winners in a test for weeks.
- **User:** a growth lead who lets AI agents run paywall and onboarding tests in Adapty, and wants them fast but unable to fool themselves.
- **Non-goals:** a new dashboard or analytics product; Bayesian/P2BB replacement; multi-app or multi-tenant auth; real user data; auto-approval of any kind.

## Verdict rules

1. **Goal metric only.** The metric is parsed from the test's declared goal text. A request on any other metric is refused as metric shopping.
2. **Horizon from the goal.** A goal of "60-day revenue per install" means only users installed ≥ 60 days before the look count, so Onboarding's first valid look is week 9. Earlier looks return `BEFORE_HORIZON`.
3. **K and horizon are parameters** from the test plan. If the plan does not give K, use the fallback (K = 15 weekly looks) and return `K_source: "fallback"` so it is visible.
4. **Boundary:** at look k of K, a winner needs `|z| ≥ c × sqrt(K/k)`, with c calibrated by A/A simulation to ≈ 5% false wins (c ≈ 2.1 for K = 15).
5. **Three verdicts:** `WINNER` (boundary crossed on the goal metric at a valid look), `CONTINUE` (not crossed, looks remain), `NO_WINNER` (last look reached, not crossed).
6. **`as_of` replay:** recompute any verdict as of a past date from the offline CSV only.
7. **Source label** on every number: `adapty_metrics` (live, ≈ 1,000 users) or `export_csv` (offline, 50,000 users).

## MCP tool contracts (Fulcrum server)

The agent gets only these tools. There is no approve tool: approval happens only in the human UI.

| Tool | Input | Output | Errors |
|---|---|---|---|
| `list_tests` | `{}` | `[{test_id, title, state, placement, goal_metric, horizon_days}]` | `ADAPTY_UNAVAILABLE` |
| `judge_test` | `{test_id, as_of?: date, metric?: string}` | `{verdict, goal_metric, look_k, K, K_source, horizon_days, z, boundary, effect, p_naive, arms[], source, reasons[]}` | `UNKNOWN_TEST`, `METRIC_NOT_GOAL`, `BEFORE_HORIZON`, `INVALID_AS_OF`, `AS_OF_REQUIRES_CSV` |
| `request_stop` | `{test_id, winner_arm_id, metric, rationale}` | `{action_id, status: "blocked" \| "pending", verdict, reason}` | `UNKNOWN_TEST`, `NOT_LIVE`, `UNKNOWN_ARM`, `DUPLICATE_PENDING` |
| `request_status` | `{action_id}` | `{action_id, status: blocked \| pending \| approved \| rejected \| executed \| failed, approved_by?, executed_at?, cli_result?}` | `UNKNOWN_ACTION` |

- `request_stop` runs `judge_test` itself. It returns `blocked` unless the verdict is `WINNER` on the goal metric for that arm.
- Asking again after a block, or rephrasing, re-runs the same check: the result only changes if the data changes.
- After approval Fulcrum runs `adapty ab-tests stop <id> --app <app> --winner <arm> --yes --json`, then confirms with `adapty ab-tests get --json`.

## Approval gate invariants

1. **No write without approval.** Every write is a pending action; only a human click in the UI moves it to `approved`; only `approved` actions execute, once.
2. **Token only in the Fulcrum process.** `ADAPTY_TOKEN` comes from `.env`, is passed to the CLI through the environment, and never appears in tool output, error messages, ledger entries or logs.
3. **Audit ledger.** Every write attempt, blocked or approved, is appended with `{id, ts, tool, test_id, args, verdict, status, reason, approved_by, cli_exit}`. Entries are never edited or deleted.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Settings `as_of` 2026-09-02 on revenue: naive p < 0.05 (≈ 0.049), but `|z|` < boundary (≈ 2.9), so `request_stop` returns `blocked`. (At the end state, p = 0.067 and z = 1.83, so the end state alone does not test the boundary.) |
| AC-2 | Onboarding on 60-day revenue per install: no valid look before week 9; at week 9 the boundary is crossed (z ≈ 4.3 vs ≈ 2.7) and the verdict is `WINNER`. |
| AC-3 | `request_stop` on Settings with `metric: "payer_rate"` (z ≈ 5.3) is refused with `METRIC_NOT_GOAL`, because its goal is revenue. |
| AC-4 | A stop with no approval never runs the CLI; an approved action runs it exactly once; a rejected one never. |
| AC-5 | The token value never appears in any tool output, error, ledger entry or log line. |
| AC-6 | 2,000+ simulated A/A tests through the boundary give 5% ± 1.5% false wins; naive weekly peeking at p < 0.05 gives ≥ 20% (≈ 22.5% with 15 looks). |
| AC-7 | Every `request_stop`, blocked or pending, adds exactly one ledger entry with a reason; approval adds `approved_by` and a timestamp. |
| AC-8 | Every number in `judge_test` carries `source`; `as_of` with `adapty_metrics` returns `AS_OF_REQUIRES_CSV`. |
| AC-9 | With no K in the test plan, `judge_test` returns `K_source: "fallback"`; with K given, it uses that K and the boundary changes. |
| AC-10 | Repeating a blocked request with the same data returns `blocked` again, with no new pending action. |

## Test plan (write after kickoff; each test is named with its AC id)

All tests use Vitest (TypeScript). Stats tests read the offline CSV in place via `OFFLINE_DATA_DIR`; gate and MCP tests mock the CLI. Tests that write to Adapty run only with `ALLOW_WRITES=1`, set by a human.

| AC | Test |
|---|---|
| AC-1 | `AC-1 Settings as_of 2026-09-02 is blocked despite naive p < 0.05` |
| AC-2 | `AC-2 Onboarding has no valid look before week 9`, `AC-2 Onboarding is WINNER at week 9 on 60-day revenue` |
| AC-3 | `AC-3 request_stop on non-goal metric returns METRIC_NOT_GOAL` |
| AC-4 | `AC-4 pending action never calls the CLI`, `AC-4 approved action calls the CLI once`, `AC-4 rejected action never calls the CLI` |
| AC-5 | `AC-5 token absent from outputs, errors, ledger and logs` |
| AC-6 | `AC-6 boundary false-win rate is about 5%`, `AC-6 naive peeking false-win rate is at least 20%` |
| AC-7 | `AC-7 every request_stop writes one ledger entry` |
| AC-8 | `AC-8 every number has a source label`, `AC-8 as_of with adapty_metrics is rejected` |
| AC-9 | `AC-9 fallback K is visible`, `AC-9 K from the plan changes the boundary` |
| AC-10 | `AC-10 repeated blocked request stays blocked, no new pending action` |
