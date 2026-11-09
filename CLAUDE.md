# Fulcrum: project instructions

Fulcrum is the only door between AI agents and an Adapty account. Agents can read everything; every change goes through Fulcrum: policy, statistics, human approval, then Fulcrum executes it through the Adapty CLI. Built at Adapty's First Commit hackathon (Belgrade, 7 to 8 Nov 2026). SPEC.md holds the contracts and acceptance criteria; README.md the overview and limitations.

## Core invariant

Any tool that writes to Adapty creates a **pending action** that only executes after human approval in the UI. Never bypass it: no direct write path, no "auto-approve" flag, no test shortcut that skips the gate. There is no approve tool for the agent.

## Secrets and data

- Credentials only via `.env` (`ADAPTY_TOKEN`). Never read, print or copy `.env`. New keys go in `.env.example` with empty values.
- Fulcrum is the only process that holds `ADAPTY_TOKEN`. It never appears in tool output, errors, ledger entries or logs.
- Offline data lives at `~/Projects/adapty-seed-data-hack/data/offline/`. Read it in place; never copy data or scripts from that repo into this one.
- Security findings never go in the public repo. They go in `SECURITY-NOTES.md`, which is gitignored.

## Adapty CLI

- Fulcrum calls Adapty through the CLI (0.18.0), not through Adapty's MCP.
- A stopped A/B test cannot be restarted. Treat `ab-tests stop` as irreversible. Verify flags with `--help`; do not guess.
- Deny rules match the literal command, so `npm test` could run CLI writes internally. **Integration tests that write to Adapty run only with `ALLOW_WRITES=1`, set by a human. Never set it automatically.**

## Verdict rules

- Judge only on the test's declared goal metric from `test-plans.json`. A request on any other metric is refused (`METRIC_NOT_GOAL`).
- The horizon comes from the goal (Onboarding: 60-day revenue, so the first valid look is week 9).
- K and the horizon come from the test plan; without K the engine uses a built-in K = 15 and reports `K_source: "fallback"`.
- Boundary: `c × sqrt(K/k)` at look k, c calibrated by simulation to about 5% false wins (c = 2.1 for K = 15).
- Every number carries its source label (`export_csv` or `adapty_metrics`).
- If a test shows a different number than the spec, fix the spec, not the code.

## Stack and checks

TypeScript strict (no `any`), ESM, Node 22, Vitest. Minimal dependencies: `@modelcontextprotocol/sdk` (stdio), Hono for the approval page. Tests are named after their AC id.

Before calling a change done: `npm run typecheck`, `npm test` and `npm run test:attacks`. The pre-commit hook (`.githooks/pre-commit`) blocks secrets, type errors and failing tests.

## Conventions

- Small commits, one logical change each, only when asked.
- Before key commits touching the gate, token handling or the boundary, have a fresh reviewer subagent check the diff against SPEC.md: can the agent bypass the gate, can the token leak, is the boundary right.
- Rough edges in the Adapty CLI, MCP, API or dashboard go in `FRICTION.md` (date | surface | what happened | suggestion).
- No em dashes in docs.
