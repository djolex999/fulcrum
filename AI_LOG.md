# AI log

How AI was used to build Fulcrum at the Adapty Hackathon Belgrade (7 to 8 Nov 2026), and what we changed, rejected and verified. Times are Europe/Belgrade.

## Harness

- **Two-layer CLAUDE.md.** A personal global file (`~/.claude/CLAUDE.md`: stack, hard rules such as never editing `.env`, "done means verified") plus this repo's [CLAUDE.md](CLAUDE.md) (event rules, Adapty facts, the approval-gate invariant, build phases, working conventions), plus a private `CLAUDE.local.md` with the full event context that is never committed. The project files win where they differ.
- **Personal skills** (in `~/.claude/skills/`):
  - `phase-checkpoint`: after every build phase, a short summary, code spots for Djordje to read, 3 questions answered one at a time and checked against the code, the README updated in Djordje's words, and an entry in this log.
  - `demo-preflight`: a read-only checklist before the demo (secrets, build, approval gate, live test, disclosure, backup video).
- **Adapty agent skills and MCP.** Adapty's official skills (`npx adapty skills install`) and the Adapty MCP server (`https://mcp.adapty.io/mcp`), used for reading the app's tests and metrics while building.
- **Permission deny rules** in [.claude/settings.json](.claude/settings.json). The coding agent cannot call any Adapty MCP write tool (27 tools, plus two app-level tools the agent never needs), cannot run any Adapty CLI write command (51 commands, including `ab-tests stop`), and cannot read `.env`. Stops are run by a human.
- **Independent reviewer subagents.** Before key commits, a fresh Claude subagent that sees only the diff and SPEC.md (not the conversation) checks three things: can the agent bypass the gate, can the token leak, is the boundary right. A second fresh subagent re-computes the pitch numbers from the CSV alone; a number goes on a slide only if it agrees with the implementation. Reviewers never get `.env` or Adapty access. Each review is logged below.
- **Vir**, Djordje's own session-distillation CLI, can summarize sessions into this log.
- **Guard hook.** A `PreToolUse` hook ([.claude/hooks/guard.sh](.claude/hooks/guard.sh)) backs up the deny rules, which only match exact command prefixes. It parses every Bash command and denies Adapty write commands in any form (`npx adapty@…`, full paths, `bash -c`, `$(…)`, chains) plus `adapty apps get`, and denies `.env` access through Bash, Read, Grep, Glob, Edit and Write. If it cannot check a call, it denies it. Tested by [.claude/hooks/guard.test.sh](.claude/hooks/guard.test.sh). This is a client-side policy, not a security boundary: the real boundary is that only the Fulcrum process holds `ADAPTY_TOKEN` (see SPEC.md). Hardened over three rounds of automated security review (quoted values, `npx`/path/`bash -c` forms, variable and ANSI-C command words, `.env` globs and brace tricks), then deliberately stopped: a text-matching guard cannot fully parse shell. Known limits: a script file that calls `adapty`, and deliberate obfuscation.
- **Activity hook.** A `PostToolUse` hook ([.claude/hooks/ai-log.sh](.claude/hooks/ai-log.sh)) appends one JSON line per Edit, Write, MultiEdit or Bash call to a local, gitignored `.ai-log/events.jsonl`: timestamp, tool, file path or the first 120 characters of the command, and a success flag. Secrets are redacted before writing (known token prefixes, `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*` values, auth headers and Bearer tokens, credentials in URLs, long random strings), and file contents and prompts are never logged. The raw log stays on the developer's machine (it is gitignored); this file is the public summary. Tested by [.claude/hooks/ai-log.test.sh](.claude/hooks/ai-log.test.sh).

## Tools and IDE, and why

- **Claude Code (desktop app)** as the only coding tool. Each piece of work runs in its own git worktree, so a review or an experiment never touches the main checkout.
- **Model split.** Reviewers run on a different model than the session that wrote the code (Fable for gate, server and data reviews; Sonnet for the builder check and some security re-reviews), so a reviewer does not share the builder's blind spots.
- **Superpowers workflow skills** set the order of work: brainstorm the design ([demo design](docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md)), write SPEC.md with acceptance criteria, write a task plan ([plan](docs/superpowers/plans/2026-11-07-fulcrum.md)), then build task by task with tests first.
- **Automated security review** (a Claude Code plugin) runs on security-relevant commits, next to the reviewer subagents.
- **Pre-commit hook** ([.githooks/pre-commit](.githooks/pre-commit)): scans staged files for secrets, then runs `tsc --noEmit` and the full test suite. A commit that fails any of them does not land.

## MCP servers, and why

| Server | Who uses it | Why |
|---|---|---|
| **Fulcrum** (ours, stdio, [src/mcp/server.ts](src/mcp/server.ts)) | the demo agent, as its **only** server ([demo/.mcp.json](demo/.mcp.json)) | Reads (tests, verdicts, timelines) plus `request_stop`, which only creates a pending action. There is no approve tool: a human approves in the browser. |
| **Adapty MCP** (`https://mcp.adapty.io/mcp`) | the coding agent, read-only | Fast reads of the seeded app's tests, placements and metrics while building. All 27 write tools are denied, plus app-level tools it does not need. |

Fulcrum calls Adapty through the Adapty CLI, not through Adapty's MCP: the MCP is built for an AI client with browser OAuth, and Fulcrum needs to be a plain server process that is the only holder of `ADAPTY_TOKEN`.

## How the project is designed around agents

- **Spec before code, tests before implementation.** Every rule (declared goal only, horizon from the goal, calibrated boundary, no write without approval, token never in output) is an acceptance criterion in SPEC.md with a test named after it. The agent builds against the tests, not against a vague prompt.
- **Numbers are not trusted until two independent paths agree.** The pitch numbers came from a pre-event analysis; a fresh subagent with no access to our code re-computed them from the raw CSV, and one of our planned demo scenes did not survive (see Cross-check 2).
- **The agent cannot weaken its own guardrails.** Deny rules, the guard hook and the sandboxed demo agent make the policy files read-only for the agent; the pre-commit hook refuses a commit with failing types or tests.
- **Small phases with a stop point.** Each phase ends when its AC tests pass, then `phase-checkpoint` makes Djordje explain the code back before the next phase starts.
- **The product applies the same idea to its own users.** Fulcrum is a harness for a growth agent: it reads freely, and every write passes a deterministic check and a human.

## Prompts that worked

Shortened paraphrases of the briefs; the point is what each one withholds or narrows.

1. **Isolated cross-check.** "You have no project context. Read only the CSVs and flow files at <path>. Do not read <repo>, any spec or any notes. For each A/B test, define revenue per install at the test's goal horizon, compute it per arm at every weekly look, and report when (if ever) |z| crosses 2.1 × sqrt(15/k). State your definitions." Giving it no numbers is what made its disagreement on Settings believable.
2. **Three-question reviewer.** "You see only this diff and SPEC.md. Answer three things, each with file:line evidence or a reproduction: can the agent reach an Adapty write without a named human approval, can the token reach any output or log, is the boundary computed as the spec says." Narrow questions found real bugs (double pending actions, self-approval with `curl`) instead of style notes.
3. **Builder check.** "Read only this design document. Before you could write an implementation plan, what would you still need to know? List questions, not suggestions." It turned an implicit design into 8 explicit decisions.

## Independent reviews

Every reviewer was a fresh Claude subagent that saw only what is listed (never the conversation, the secrets file or Adapty access). Detailed reports are kept locally.

| When (Sat) | Reviewer | Saw / asked | Found | What changed |
|---|---|---|---|---|
| ~12:05 | subagent, raw CSV only, none of our numbers | re-compute the pitch numbers | Onboarding week 9 and the Settings end state agree; extra revenue ≈ $19.4k by an age-curve method; "Settings as of 2 Sep" does not hold (p 0.26) | 2 Sep scene dropped; money re-estimated (≈ $19k) |
| ~12:25 | Fable, raw CSV only | Settings, every weekly look, five metrics | one naive-significant `settings` lead (16 Aug, 30-day RPI, fragile); the boundary never crossed; `main_lifetime` leads at the end | demo rebuilt around 16 Aug and Onboarding "not yet, then now" |
| ~12:40 | Sonnet, design doc only | what is missing before a plan | 8 open questions (contracts, cutoffs, calibration, approval security, …) | all 8 answered in the [demo design](docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md) |
| ~13:40 | Fable + security plugin | approval gate diff + gate invariants | duplicate pending actions under concurrency; approvable before the ledger write; judge codes lost | slot reserved before any await, ledger first, codes passed through |
| ~14:20 | Fable | MCP server diff + SPEC.md | no bypass, no token leak, clean stdout | minor findings carried into wiring |
| ~14:30–15:00 | Sonnet + Fable + security plugin | approval page | **the agent could approve its own request with `curl`**; reusable login link; cookies shared across localhost ports | single-use login code, random session cookie, CSRF, Origin and Host checks; guard denies the approval port |
| ~15:00–15:45 | Sonnet + security plugin (4 rounds) | demo agent isolation | the agent could edit Fulcrum or its policy files, plant a fake `tsx`, or redirect imports with a hostile `tsconfig.json` | OS sandbox, write-denied policy and loader files, pinned loader, regression test |
| ~16:00–17:00 | Sonnet + Fable | verdict engine | looks anchored on time of day (16 Aug hit the wrong look); unlabelled end views; a SPEC p-value on the wrong metric | day-aligned looks (week 9 z 4.49 → 4.34, same verdict), labels, SPEC fixed (the spec moved, not the tolerance) |
| ~17:30 | Fable + Sonnet | real verdicts behind the tools | duplicate arm names could map to one flow; evidence from a second judge call | one-to-one arm mapping; one judge call is both decision and evidence |
| ~17:00–18:10 | Fable + Sonnet + security plugin | closed loop, attack suite, demo safety | live-test rule compared titles; backup script did not pass its port | match by placement id (fails closed); backup forwards only its port |

**Known limits, said openly:** on one machine and one OS user, a determined local process could read the one-time login code during its 60 s window or browser state, and the agent runs as the same OS user as Fulcrum. In production Fulcrum would run as a separate service under its own user, and approvals would use a separate channel.

## Phases

One entry per build phase, written at the end of `phase-checkpoint` in Djordje's words.

<!--
### Phase N: <name>

- **Time:** HH:MM to HH:MM (Europe/Belgrade), <day>
- **Goal:** what this phase was meant to deliver (ACs from SPEC.md)
- **What AI produced:** files and functions, in plain words
- **What I changed or rejected, and why:**
- **Verification:** tests run and result, closed ACs, reviewer subagent findings
- **Open issues:**
- **Events logged this phase:** N (from .ai-log/events.jsonl)
-->

### Phases 1–2: the only door, and real verdicts

- **Time:** 10:10 to 16:40 (Europe/Belgrade), Saturday 7 Nov.
- **Goal:** Phase 1, the only door between the agent and Adapty (AC-BYPASS, AC-TOKEN, AC-4, AC-5, AC-7, AC-10, AC-12). Phase 2, verdicts on the declared goal with a calibrated boundary (AC-1, AC-2, AC-PEEK, AC-SHOP, AC-CALIB, AC-8, AC-9, AC-11).
- **What AI produced:** the MCP server with five tools, the token kept inside Fulcrum, the approval gate and ledger, the human-only approval page, the sandboxed demo agent; the CSV loader, revenue per install, the boundary and its simulation, the verdict engine, and the real verdicts behind the tools. In my words: "the agent has no token, it only has requests"; "no user has done 60 days, until that is accomplished it's always not yet"; "Fulcrum adds it in code, Adapty's MCP is just a prompt."
- **What I changed or rejected, and why:** nothing, AI built it. Decisions I made along the way: the Settings scene moved from 2 Sep to 16 Aug after the independent check, the positioning narrowed to "the only door" (no dashboards), and the activity log stays private.
- **Verification:** 140 tests pass (typecheck clean). Every task had an independent review (Sonnet, Fable for the gate, the MCP server, the verdicts and the wiring); fix rounds are logged above. Pitch numbers re-derived independently. Not yet verified by hand: the live throwaway stop and the sandbox in `demo/`.
- **Open issues:** AC-LOOP (`propose_test`) and AC-POLICY are not built; the live throwaway run and the manual check in `demo/` are still to do.
- **Events logged this phase:** 58 (from 13:58, when the activity hook started logging).
