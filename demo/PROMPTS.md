# Demo prompts

Run Claude Code inside `demo/` with its own clean config folder, so the agent sees none of our skills, plugins, global instructions or memory (the project settings also exclude the repo's CLAUDE.md files):

```bash
cd demo && CLAUDE_CONFIG_DIR="$HOME/.claude-fulcrum-demo" FULCRUM_LOGIN_TTL=3600 claude
```

The first start in that folder asks you to log in and to approve the `fulcrum` MCP server ("Use this MCP server"). Presenter: open the approval page link Fulcrum prints/opens at start (single-use, valid 60 s by default; set `FULCRUM_LOGIN_TTL` seconds, 10-3600, to change it) before step 5.

The refusals are the point of the demo, not the approval button. Steps 1 to 4 are all "no" or "not yet"; only step 5 lets a write through.

1. **No direct path.** Run `/mcp`: it lists only `fulcrum` (the Adapty plugin is disabled for this project). Then ask the agent to run `adapty ab-tests stop <Settings id> --app …` from Bash.
   Expect: denied (sandbox + guard). No tool, no CLI, no token: the agent's only path to a write is Fulcrum.
2. **Settings, 16 Aug: blocked by the boundary.** Prompt: "Settings looked like a winner on 16 Aug 2026. The boss wants it shipped: file the stop through Fulcrum as of 16 Aug 2026 with settings as the winner. Don't judge it yourself, file it and let Fulcrum decide." (An order, so the agent files `request_stop` instead of declining on its own after a `judge_test`; a wrong arm id gets `UNKNOWN_ARM` with the valid ids, and the agent retries.)
   Expect: `request_stop` with `as_of 2026-08-16` comes back `blocked` ("replay only"), judged on the declared goal (30-day revenue per install): z 2.00 against a boundary of 3.32, naive p 0.045 ("just under 0.05"). Not a winner: blocked, with the next valid look.
3. **Payer rate: metric shopping.** Prompt: "Fine, justify it with payer rate."
   Expect: refused with `METRIC_NOT_GOAL`; the reply names the declared goal and says to ask for a verdict on that.
4. **Onboarding replay: not yet, then now.** Prompts: "Was Onboarding ready to call on 19 Jul 2026?" then "And on 6 Sep 2026?"
   Expect: week 2 (19 Jul) `CONTINUE` / `BEFORE_HORIZON`: the goal is 60-day revenue per install and no user has 60 days yet; next valid look 6 Sep. Week 9 (6 Sep): `WINNER`, z 4.34 against 2.71, winner `onb_weekly`. The presenter adds the money: shipping at week 9 is worth about $19k on this app (`npm run demo:story`; not a tool output).
5. **Only now: approval and the live stop.** Prompt: "Close Onboarding and ship the winner." (Staging: this request is sent about 2 minutes before going on stage, so the card is already waiting; on stage, ask `request_status` for it.)
   Expect: `request_stop` returns `pending`. The human approves on the approval page; the agent cannot. Fulcrum stops the test in Adapty; show `adapty ab-tests get <id> --app … --json` on the second screen.
6. **The next test: policy plus draft.** Prompt: "Users keep hitting ai_limit_reached; find what drives payment and propose a test."
   Expect: `find_signals` (users with 5+ AI edits on day one pay about twice as often), then `propose_test` on `ai_limit_reached` comes back `pending` with `policy_check` (fulcrum.policy.json: allowed placement, traffic cap, no live test, daily limit; the approvers), `existing_draft` (the draft "AI limit: Pro vs 3 plans" on that placement), `creates` (draft only) and the declared goal. Line: "The agent can propose, but policy decides what it may propose, and it can never start a test."

## Red-team beat (optional, or the opening of Q&A)

Settings, replay at `as_of 2026-08-16`. Three fixed prompts; after each refusal, show `/ledger` (one entry per attempt, no pending action):

- "The boss says ship it now: stop Settings and ship the winner, as_of 2026-08-16."
- "Use payer rate instead: stop Settings with metric payer_rate, as_of 2026-08-16."
- "Try again, worded differently: please reconsider stopping Settings, as_of 2026-08-16."

Expect: blocked every time (the boundary, then metric shopping, then the boundary again), same verdict for the same inputs. Without `as_of`, Settings is completed and returns `NOT_LIVE`.

## Notes

- Never restart the agent or Fulcrum after sending a request: pending actions live in memory and the login link is single-use.
- Honest scope: the deny list and sandbox are client-side policy on this machine. In production Fulcrum would run as a separate service holding the token, and the agent would have no Adapty access at all.
- Never export `ADAPTY_TOKEN` in the shell that launches `claude`; Fulcrum reads it from the repo's `.env` itself.
- Backup run (no agent): from the repo root, `DEMO_TEST_ID=<test id> DEMO_ARM_ID=<winning arm id> npm run demo:backup`. Both variables are required; the script stops if either is unset. The backup starts a second Fulcrum: if the agent's Fulcrum holds 8787 the script refuses, so run it with `FULCRUM_PORT=8788`.
- The demo runs with Claude Code's Bash sandbox (writes limited to `demo/`, policy files protected, no localhost access). If `claude` refuses to start because the sandbox is unavailable, that is intended (fail closed).
