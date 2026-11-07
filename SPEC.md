# Fulcrum spec

> **Status (Sat 7 Nov, evening):** AC-BYPASS, AC-TOKEN, AC-PEEK, AC-SHOP, AC-CALIB and the supporting AC-1 to AC-12 are implemented and pass (`npm test`). AC-LOOP and AC-POLICY are in progress. The design and demo story are in [docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md](docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md). Numbers marked ≈ are reproduced by the tests.

## Positioning

Fulcrum is the only door between AI agents and an Adapty account. Agents can read everything. Every change goes through Fulcrum: policy, statistics, human approval, then Fulcrum executes. It lets agents safely make apps more money.

## Goal, user, non-goals

- **Goal:** help subscription apps make more money by stopping A/B test decisions that are wrong: shipping fake winners, and leaving real winners in a test for weeks.
- **User:** a growth lead who lets AI agents run paywall and onboarding tests in Adapty, and wants them fast but unable to fool themselves.
- **Non-goals:** a dashboard or human-facing experiment judge; test health checks; a new analytics product; Bayesian/P2BB replacement; multi-app or multi-tenant auth; real user data; auto-approval of any kind.

## Verdict rules

1. **Goal metric only.** Each test's declared goal (metric, horizon, K) comes from the checked-in test plan file `test-plans.json`, shown as `goal_source: "test_plan"`, because Adapty does not store a machine-readable goal metric. Onboarding: 60-day revenue per install (matches its Adapty goal text, "maximises 60-day revenue per install"). Settings: 30-day revenue per install (its Adapty goal text, "Earlier test - stopped with a winner", names no metric, so the test plan declares it). A request on any other metric is refused with reason "metric shopping".
2. **RPI** = net revenue (refunds subtracted at refund time) within the horizon, over all installs that have the full horizon (to date: all installs up to the cutoff); z is Welch on per-user values; looks are day-aligned (rule 7).
3. **Horizon from the goal.** A goal of "60-day revenue per install" means only users installed ≥ 60 days before the look count, so Onboarding's first valid look is week 9. Earlier looks return `BEFORE_HORIZON`.
4. **K and horizon are parameters** from the test plan. If the plan does not give K, use the fallback (K = 15 weekly looks) and return `K_source: "fallback"` so it is visible.
5. **Boundary:** at look k of K, a winner needs `|z| ≥ c × sqrt(K/k)`, with c calibrated by A/A simulation to ≈ 5% false wins (c ≈ 2.1 for K = 15).
6. **Three verdicts:** `WINNER` (boundary crossed on the goal metric at a valid look), `CONTINUE` (not crossed, looks remain), `NO_WINNER` (last look reached, not crossed).
7. **Looks are day-aligned:** look k ends at 00:00 UTC of the first-install day + 7k days. (The independent pre-event checks anchored on the first-install timestamp and got z ≈ 4.49 at week 9; same week, same verdict.)
8. **`as_of` replay:** recompute any verdict as of a past date from the offline CSV only.
9. **Source label** on every number: `adapty_metrics` (live, ≈ 1,000 users) or `export_csv` (offline, 50,000 users).

## MCP tool contracts (Fulcrum server)

The agent gets only these tools. There is no approve tool: approval happens only in the human UI.

| Tool | Input | Output | Errors |
|---|---|---|---|
| `list_tests` | `{}` | `[{test_id, title, state, placement, goal_metric, horizon_days}]` | `ADAPTY_UNAVAILABLE` |
| `judge_test` | `{test_id, as_of?: date, metric?: string, source?: "csv" \| "adapty_metrics"}` | `{verdict, goal_metric, look_k, K, K_source, horizon_days, z, boundary, effect, p_naive, arms[], source, reasons[]}` | `UNKNOWN_TEST`, `INVALID_AS_OF`, `AS_OF_REQUIRES_CSV`, `ADAPTY_UNAVAILABLE`, `NOT_IMPLEMENTED` (`METRIC_NOT_GOAL` and `BEFORE_HORIZON` are verdict codes, not errors) |
| `test_timeline` | `{test_id, metric?: string}` | `{goal_metric, K, K_source, looks: [{k, date, z, boundary, crossed, leader, p_naive}], first_crossing?: {k, date, arm}, end: {date, leader, effect, p_naive, arms: [{arm, n}]}, source}` | `UNKNOWN_TEST`, `ADAPTY_UNAVAILABLE`, `NOT_IMPLEMENTED` |
| `request_stop` | `{test_id, winner_arm_id, metric, rationale, as_of?: date}` | `{action_id, status: "blocked" \| "pending", verdict, reason}` | `UNKNOWN_TEST`, `INVALID_AS_OF`, `NOT_LIVE`, `UNKNOWN_ARM`, `DUPLICATE_PENDING`, `ADAPTY_UNAVAILABLE` (a request still being judged returns `blocked`, "request in progress"; `BEFORE_HORIZON` and `METRIC_NOT_GOAL` are `blocked` results with that code) |
| `propose_test` | `{placement, flows: [flow_a, flow_b], audience: segment_id \| "all", traffic_share, hypothesis}` | `{action_id, status: "blocked" \| "pending", policy_rule?, reason}` | `UNKNOWN_PLACEMENT`, `UNKNOWN_FLOW`, `TEST_ALREADY_RUNNING`, `DUPLICATE_PENDING` |
| `request_status` | `{action_id}` | `{action_id, status: blocked \| pending \| approved \| rejected \| executed \| failed, approved_by?, executed_at?, cli_result?}` | `UNKNOWN_ACTION` |

- `request_stop` runs `judge_test` itself. It returns `blocked` unless the verdict is `WINNER` on the goal metric for that arm. With `as_of` (replay) it only ever returns the verdict and a ledger entry, never a pending action: a past date can't be executed.
- For a completed test, `request_stop` returns `NOT_LIVE`, and `judge_test` / `test_timeline` still explain whether the declared winner was supported.
- Asking again after a block, or rephrasing, re-runs the same check: the result only changes if the data changes.
- After approval Fulcrum runs `adapty ab-tests stop <id> --app <app> --winner <arm> --yes --json`, then confirms with `adapty ab-tests get --json`.
- `propose_test` checks policy (allowed placement, max traffic share, no test already running on that placement and audience, daily write limit) and queues a pending action; after approval Fulcrum runs `adapty ab-tests create` then `adapty ab-tests start` (flags verified with `--help` first) and confirms with `ab-tests get`. A blocked proposal cites the policy rule.

## Policy (`fulcrum.policy.yaml`, one per app)

`approvers` (names allowed to approve), `allowed_actions` (`stop_test`, `create_test`), `min_horizon_days` per goal metric, `max_traffic_share` for new tests, `daily_write_limit`. Fulcrum loads and validates it at start; an invalid or missing policy **fails closed** (every write blocked, reason "invalid policy"). Every block cites the rule (for example `policy_rule: "max_traffic_share"`).

## Approval gate invariants

1. **No write without approval.** Every write is a pending action; only a human click in the UI moves it to `approved`; only `approved` actions execute, once.
2. **Token only in the Fulcrum process.** `ADAPTY_TOKEN` comes from `.env`, is passed to the CLI through the environment, and never appears in tool output, error messages, ledger entries or logs.
3. **Audit ledger.** Every write attempt, blocked or approved, is appended with `{id, ts, tool, test_id, args, verdict, status, reason, approved_by, cli_exit}`. Entries are never edited or deleted.

## Acceptance criteria

### Priority criteria (named; never cut AC-BYPASS, AC-TOKEN, AC-CALIB)

| ID | Criterion |
|---|---|
| AC-BYPASS | With the project's demo client config, a direct Adapty MCP write tool (e.g. `ab_tests_stop`) or CLI write command (`adapty ab-tests stop …`) from the agent is **denied**; the same action requested through Fulcrum's `request_stop` reaches the gate. The demo script has a step that shows the denial. |
| AC-TOKEN | `ADAPTY_TOKEN` exists only in the Fulcrum process (not in the agent's MCP config or environment); no Fulcrum tool output, error, log line or ledger entry contains it. (Covers AC-5 and AC-12.) |
| AC-PEEK | Settings as of **2026-08-16** on its declared goal (30-day RPI): naive p < 0.05 (≈ 0.045, n 153/175 at 2026-08-16T00:00Z) but \|z\| below the boundary at that look (≈ 3.32), so `request_stop` is `blocked` and the response shows the boundary. *Correction of the requested 2026-09-02: two independent checks give p = 0.26 there, so it is not a peeking moment.* |
| AC-SHOP | A stop justified by a metric that is not the declared goal is refused with reason "metric shopping" (code `METRIC_NOT_GOAL`). Example: Settings with `metric: "payer_rate"`. (Supersedes AC-3.) |
| AC-LOOP | The agent calls `propose_test` with a placement, two flows, an audience and a hypothesis; Fulcrum checks policy (allowed placement, max traffic share, no test already running there) and queues it; after approval Fulcrum runs `ab-tests create` and `start`. Demo target: users with 5+ AI edits on day one, new test on `ai_limit_reached`. |
| AC-POLICY | `fulcrum.policy.yaml` per app (approvers, allowed actions, min horizon per goal, max traffic share, daily write limit) is enforced; every block cites the rule; an invalid policy fails closed. |
| AC-CALIB | The simulation shows ≈ 5% false wins with the boundary and ≥ 20% with naive weekly peeking. (Same as AC-6.) |

### Supporting criteria (existing; test names in the code use these ids)

| ID | Criterion |
|---|---|
| AC-1 | Settings (declared winner `settings` in Adapty): `test_timeline` on the goal metric shows **no look where the boundary is crossed in `settings`' favour**, and at the end `main_lifetime` leads on its goal metric (30-day RPI): effect ≈ −$0.68, p ≈ 0.50 at the end of the data, or ≈ −$0.91, p ≈ 0.41 at look 15 (2026-10-18). On revenue to date (not the goal; shown for explanation only) it is ≈ −$1.57, p ≈ 0.067. `judge_test` reports the declared winner as not supported. |
| AC-2 | Onboarding on 60-day revenue per install: `request_stop` with `as_of` at week 2 returns `blocked` with `BEFORE_HORIZON` ("not yet"); the first valid look is week 9, where the boundary is crossed (z ≈ 4.34 vs ≈ 2.71) and the verdict is `WINNER` for weekly first ("now"). |
| AC-3 | Superseded by AC-SHOP. |
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
| AC-SHOP | `AC-SHOP payer-rate stop for Settings is refused as metric shopping` |
| AC-PEEK | `AC-PEEK Settings as_of 2026-08-16 is blocked by the boundary despite naive p < 0.05` |
| AC-BYPASS | `AC-BYPASS demo config denies Adapty write tools and CLI writes`, `AC-BYPASS the same stop through Fulcrum reaches the gate` |
| AC-TOKEN | `AC-TOKEN token absent from outputs, errors, ledger and logs` (with AC-5, AC-12) |
| AC-LOOP | `AC-LOOP propose_test queues a pending create after policy check`, `AC-LOOP approved proposal runs create then start` |
| AC-POLICY | `AC-POLICY every block cites its rule`, `AC-POLICY invalid policy fails closed` |
| AC-CALIB | the AC-6 tests |
| AC-4 | `AC-4 pending action never calls the CLI`, `AC-4 approved action calls the CLI once`, `AC-4 rejected action never calls the CLI` |
| AC-5 | `AC-5 token absent from outputs, errors, ledger and logs` |
| AC-6 | `AC-6 boundary false-win rate is about 5%`, `AC-6 naive peeking false-win rate is at least 20%` |
| AC-7 | `AC-7 every request_stop writes one ledger entry` |
| AC-8 | `AC-8 every number has a source label`, `AC-8 as_of with adapty_metrics is rejected` |
| AC-9 | `AC-9 fallback K is visible`, `AC-9 K from the plan changes the boundary` |
| AC-10 | `AC-10 repeated blocked request stays blocked, no new pending action` |
| AC-11 | `AC-11 Onboarding extra revenue is within 15% of the independent check` |
| AC-12 | `AC-12 demo agent config has only the Fulcrum server and no token` |
