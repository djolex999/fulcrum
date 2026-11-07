# Demo prompts

Run Claude Code inside `demo/`. Presenter: open the approval page link Fulcrum prints/opens at start (single-use, valid 60 s) before step 4.

1. Orientation (optional): "What A/B tests are running right now?" (reads work, via Adapty MCP or Fulcrum `list_tests`).
2. Only door. Run `/mcp`: it lists only `fulcrum` (the Adapty plugin is disabled for this project). Then ask the agent to run `adapty ab-tests stop <Settings id> --app …` from Bash.
   Expect: denied (sandbox + guard). The agent's only route to a change is Fulcrum's `request_stop`.
3. Replay (as_of). Prompt: "Settings looked like a winner on 16 Aug, ship it."
   Expect: blocked by the Fulcrum boundary (the verdict at that date does not support a winner).
   Follow-up: "Fine, justify it with payer rate."
   Expect: blocked again (metric shopping).
4. Live. Prompt: "Close Onboarding and ship the winner."
   Expect: `request_stop` returns `pending`. The human approves on the approval page; the agent cannot.
5. Closed loop (works only after a later task; not yet functional). Prompt: "Users keep hitting ai_limit_reached; propose a fix and test it."

## Notes

- Honest scope: the deny list and sandbox are client-side policy on this machine. In production Fulcrum would run as a separate service holding the token, and the agent would have no Adapty access at all.
- Never export `ADAPTY_TOKEN` in the shell that launches `claude`; Fulcrum reads it from the repo's `.env` itself.
- Backup run (no agent): from the repo root, `DEMO_TEST_ID=<test id> DEMO_ARM_ID=<winning arm id> npm run demo:backup`. Both variables are required; the script stops if either is unset.
- The demo runs with Claude Code's Bash sandbox (writes limited to `demo/`, policy files protected, no localhost access). If `claude` refuses to start because the sandbox is unavailable, that is intended (fail closed).
