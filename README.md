# Fulcrum

> **Status (Sat 7 Nov, evening):** built and tested: the MCP server, the approval gate and ledger, the human-only approval page, the isolated demo agent, and the verdict engine (declared goal, horizon, sequential boundary, `as_of` replay, metric-shopping refusal). In progress: `propose_test` (the agent proposes a new test through the same gate) and the policy file. Run `npm run demo:story` to see the evidence.

Fulcrum is the only door between AI agents and an Adapty account. There is no tool, no CLI and no token for the agent: its only path to a write is Fulcrum. Agents can read test data; every change passes the test's declared goal, a sequential stopping boundary and a human approval, and only then does Fulcrum execute it.

## The problem

Growth teams running paywall and onboarding A/B tests routinely:

- stop tests too early, before enough data has come in;
- misread winners, treating noise or a short-lived lift as a real effect;
- peek at results repeatedly, which inflates the rate of false wins.

The result is shipped "winners" that never actually won.

## How it works

- **Approval gate:** the agent has no token, it only has requests. A request becomes pending only if the statistics say there is a winner for that exact arm, and only a human clicking Approve on the local page makes Fulcrum stop the test. Adapty's own MCP asks the model to confirm before a stop, which is just a prompt; Fulcrum adds the rule in code, plus statistics, a human approver and a ledger of every attempt.
- **Verdict engine:** a test is judged only on its declared goal. For Onboarding that is 60-day revenue per install, so until users have been in the app for 60 days the answer is always "not yet"; the first week anyone qualifies is week 9, and that is where it crosses the boundary.
- **Agent loop:** to be written during the event.
- **Stopping boundaries:** to be written during the event.

## Limitations

- **Synthetic data.** All numbers come from the public synthetic Lumen dataset (`export_csv`). The live stop is judged on that offline export; live `adapty_metrics` (about 1,000 of today's users) is not wired in yet.
- **Isolation is client policy plus token absence.** The demo agent has no Adapty tool, no CLI write and no token; its only path to a write is Fulcrum. On one machine and one OS user this is enforced by Claude Code's sandbox, deny rules and a hook. In production Fulcrum would run as a separate service that holds the token.
- **Approval page.** Local only (127.0.0.1), one human approver, a one-time login link; no multi-user auth.
- **Gate state is in memory.** Restarting Fulcrum drops pending requests (the ledger on disk is kept).

## Built with

- Adapty CLI (Fulcrum calls Adapty through it)
- Model Context Protocol (`@modelcontextprotocol/sdk`): Fulcrum is an MCP server for the agent
- Claude Code: the agent in the demo (connected to Fulcrum over MCP) and the build tool
- TypeScript on Node 22, Hono, Vitest

## Disclosure

- **Pre-event work:** we analyzed the public Lumen demo dataset (`adapty-seed-data-hack`) before the event to understand its shape. No code or data from that analysis is reused in this repository.
- **Made before kickoff:** a break-time display screen, a draft slide deck, a draft spec (SPEC.md), and the AI log tooling (AI_LOG.md, the `.claude/hooks/ai-log.sh` hook and its test), and a guard hook for the coding agent (`.claude/hooks/guard.sh` and its test).
- **Pre-existing personal tooling**, not part of the project core: Claude Code skills (`phase-checkpoint`, `demo-preflight`), hooks, and Vir (Djordje's own session-distillation CLI).
- **AI tools:** Claude Code, including fresh reviewer subagents that see only the diff and the spec.
- **Boilerplate / third-party starters:** none yet. Anything used will be listed here.

## Data

Demo and synthetic data only, from the Lumen demo app provided for the hackathon. No real user data.

## Team

**Fulcrum**

- Djordje Marković
- Milica Petković

## License

MIT, see [LICENSE](LICENSE).
