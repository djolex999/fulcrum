# Fulcrum spec

> **Status:** every acceptance criterion below (AC-BYPASS, AC-TOKEN, AC-PEEK, AC-SHOP, AC-LOOP, AC-POLICY, AC-CALIB and the supporting AC-1 to AC-12) is implemented and passes (`npm test`, 199 tests). Not built: the `adapty_metrics` source, and reading `fallbackHorizonDays` from the policy file. The design and demo story are in [docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md](docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md). Numbers marked ≈ are reproduced by the tests.

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
4. **K and horizon are parameters** from the test plan. If the plan does not give K, use the fallback (the policy's `fallbackK`, else K = 15 weekly looks) and return `K_source: "fallback"` so it is visible.
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
| `judge_test` | `{test_id, as_of?: date, metric?: string, source?: "csv" \| "adapty_metrics"}` | `{verdict, goal_metric, look_k, K, K_source, horizon_days, z, boundary, effect, p_naive, arms[], source, reasons[]}` | `UNKNOWN_TEST`, `INVALID_AS_OF`, `AS_OF_REQUIRES_CSV`, `ADAPTY_UNAVAILABLE`, `NOT_IMPLEMENTED` (returned today for `source: "adapty_metrics"`; `METRIC_NOT_GOAL` and `BEFORE_HORIZON` are verdict codes, not errors) |
| `test_timeline` | `{test_id, metric?: string}` | `{goal_metric, K, K_source, looks: [{k, date, z, boundary, crossed, leader, p_naive}], first_crossing?: {k, date, arm}, end: {date, leader, effect, p_naive, arms: [{arm, n}]}, source}` | `UNKNOWN_TEST`, `ADAPTY_UNAVAILABLE`, `NOT_IMPLEMENTED` |
| `request_stop` | `{test_id, winner_arm_id, metric, rationale, as_of?: date}` | `{action_id, status: "blocked" \| "pending", verdict, reason}` | `UNKNOWN_TEST`, `INVALID_AS_OF`, `NOT_LIVE`, `UNKNOWN_ARM`, `DUPLICATE_PENDING`, `ADAPTY_UNAVAILABLE` (a request still being judged returns `blocked`, "request in progress"; `BEFORE_HORIZON` and `METRIC_NOT_GOAL` are `blocked` results with that code) |
| `propose_test` | `{placement, flows: [flow_a, flow_b], challenger_weight (percent, default 50), audience: segment_id \| "all", hypothesis}` | `{action_id, status: "blocked" \| "pending", policy_rule?, reason}` | `UNKNOWN_PLACEMENT`, `UNKNOWN_FLOW`, `INVALID_FLOWS`, `DUPLICATE_PENDING` |
| `find_signals` | `{}` | `{metric: "pay_rate", by: "ai_edits_first_day", buckets: [{bucket: "0" \| "1-4" \| "5+", n, payers, pay_rate}], ratio_5plus_vs_1to4, source, next_step}` (read-only) | `NOT_IMPLEMENTED` |
| `request_status` | `{action_id}` | `{action_id, status: blocked \| pending \| approved \| rejected \| executed \| failed, approved_by?, executed_at?, cli_result?}` | `UNKNOWN_ACTION` |

- `request_stop` runs `judge_test` itself. It returns `blocked` unless the verdict is `WINNER` on the goal metric for that arm. With `as_of` (replay) it only ever returns the verdict and a ledger entry, never a pending action: a past date can't be executed.
- For a completed test, `request_stop` returns `NOT_LIVE`, and `judge_test` / `test_timeline` still explain whether the declared winner was supported.
- Asking again after a block, or rephrasing, re-runs the same check: the result only changes if the data changes.
- After approval Fulcrum runs `adapty ab-tests stop <id> --app <app> --winner <arm> --yes --json`, then confirms with `adapty ab-tests get --json`.
- `propose_test` checks policy (allowed placement, max challenger weight, no **live** test on the placement, daily write limit) and queues a pending proposal; a **draft** already on the placement is named in the reply but does not block. After a human in `approvers` approves, Fulcrum re-checks policy and runs `adapty ab-tests create ... --json` **once**, which creates a **draft**. **Fulcrum never starts a test: starting it stays a human decision in Adapty.** Pending and approved replies say: "Fulcrum will create the test as a draft; starting it is your decision in Adapty." Any CLI error marks the proposal `failed` with a redacted reason and nothing is retried. A blocked proposal cites the policy rule. Proposals use their own queue (`src/gate/proposals.ts`) with the same invariants as stops (ledger first, per-placement reservation, `DUPLICATE_PENDING`, 30-minute expiry, at most once).
- `find_signals` returns the pay rate (share of users with a paid purchase, net of refunds) by AI edits on day one (0, 1-4, 5+) from the offline CSV, with a next-step line pointing at `propose_test`.

## Policy (`fulcrum.policy.json`, repo root)

JSON, no extra dependency: `{ "approvers": ["Djordje"], "allowedPlacements": ["ai_limit_reached"], "maxChallengerWeight": 50, "fallbackK": 15, "fallbackHorizonDays": null, "dailyWriteLimit": 5 }`. `approvers` are the names allowed to approve a proposed test (case-insensitive); `allowedPlacements` are placement developer ids; `maxChallengerWeight` is the most traffic (percent, 1-99) the challenger arm may get; `dailyWriteLimit` counts executed writes (stops and creates) per UTC day from the ledger. `fallbackK` (1 to 52) is the K used for a test whose plan gives none, reported as `K_source: "fallback"`; with an invalid policy file the engine uses its built-in K = 15 and says so in the verdict reason and the log. Only K = 15 has a precomputed c; any other K gets c calibrated by simulation (40k A/A runs) on first use, accurate to about ±0.02, which keeps false wins within about 0.3 points of 5%. Changing `fallbackK` while a test without a plan K is running changes the boundary for its remaining looks, so a test should declare K in its plan before it starts. `fallbackHorizonDays` is recorded but **not yet wired into the verdict engine**. `loadPolicy` validates strictly (unknown keys, wrong types and out-of-range values are errors). A **missing or invalid file fails closed**: every proposal is blocked with `policy_rule: "invalid_policy"` and a reason naming the problem. Every block cites its rule (`invalid_policy`, `allowed_placements`, `max_challenger_weight`, `live_test_on_placement`, `daily_write_limit`, `live_tests_unverifiable`). Stop approvals are not yet restricted by `approvers`.

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
| AC-PEEK | Settings as of **2026-08-16** on its declared goal (30-day RPI): naive p < 0.05 (≈ 0.045, n 153/175 at 2026-08-16T00:00Z) but \|z\| below the boundary at that look (≈ 3.32), so `request_stop` is `blocked` and the response shows the boundary. *An earlier candidate date failed two independent checks (p = 0.26), so it was replaced by this one; see AI_LOG.md.* |
| AC-SHOP | A stop justified by a metric that is not the declared goal is refused with reason "metric shopping" (code `METRIC_NOT_GOAL`). Example: Settings with `metric: "payer_rate"`. (Supersedes AC-3.) |
| AC-LOOP | The agent calls `propose_test` with a placement, two flows, an audience and a hypothesis; Fulcrum checks policy (allowed placement, max challenger weight, no live test there) and queues it; after approval by a policy approver Fulcrum runs `ab-tests create` once, producing a **draft**; starting stays a human action in Adapty. Demo target: users with 5+ AI edits on day one (about 31% pay vs about 16% for 1-4 edits), new test on `ai_limit_reached`. |
| AC-POLICY | `fulcrum.policy.json` (approvers, allowed placements, max challenger weight, daily write limit) is enforced for proposed tests; fallback K and horizon are validated but not yet read by the verdict engine; every block cites the rule; a missing or invalid policy fails closed with `invalid_policy`. |
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
| AC-LOOP | `AC-LOOP propose_test queues a pending create after policy check`, `AC-LOOP approved proposal runs create only, once, never start`, `AC-LOOP find_signals shows 5+ edits paying about twice as often` |
| AC-POLICY | `AC-POLICY every block cites its rule`, `AC-POLICY a missing file fails closed`, `AC-POLICY an invalid file fails closed` |
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
