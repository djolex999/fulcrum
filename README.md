# Fulcrum

> **DRAFT.** Written before the Adapty Hackathon Belgrade (7 to 8 Nov 2026) kickoff. Nothing described below is built yet.

A guard layer between AI agents and Adapty: agents can read everything, but every change passes a statistical check and a human approval before Fulcrum executes it.

## The problem

Growth teams running paywall and onboarding A/B tests routinely:

- stop tests too early, before enough data has come in;
- misread winners, treating noise or a short-lived lift as a real effect;
- peek at results repeatedly, which inflates the rate of false wins.

The result is shipped "winners" that never actually won.

## How it works

- **Approval gate:** to be written during the event.
- **Verdict engine:** to be written during the event.
- **Agent loop:** to be written during the event.
- **Stopping boundaries:** to be written during the event.

## Built with

- Adapty CLI
- Adapty MCP
- Claude API
- Next.js
- Python

## Disclosure

- **Pre-event work:** we analyzed the public Lumen demo dataset (`adapty-seed-data-hack`) before the event to understand its shape. No code or data from that analysis is reused in this repository.
- **Made before kickoff:** a break-time display screen, a draft slide deck, a draft spec (SPEC.md), and the AI log tooling (AI_LOG.md, the `.claude/hooks/ai-log.sh` hook and its test), and a guard hook for the coding agent (`.claude/hooks/guard.sh` and its test).
- **AI tools:** Claude Code, with custom skills and hooks.
- **Boilerplate / third-party starters:** none yet. Anything used will be listed here.

## Data

Demo and synthetic data only, from the Lumen demo app provided for the hackathon. No real user data.

## Team

**Fulcrum**

- Djordje
- Milica Petković
