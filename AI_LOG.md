# AI log

How AI was used to build Fulcrum at the Adapty Hackathon Belgrade (7 to 8 Nov 2026), and what we changed, rejected and verified. Times are Europe/Belgrade.

## Harness

- **Two-layer CLAUDE.md.** A personal global file (`~/.claude/CLAUDE.md`: stack, hard rules such as never editing `.env`, "done means verified") plus this repo's [CLAUDE.md](CLAUDE.md) (event rules, Adapty facts, the approval-gate invariant, build phases, working conventions), plus a private `CLAUDE.local.md` with the full event context that is never committed. The project files win where they differ.
- **Personal skills** (in `~/.claude/skills/`):
  - `phase-checkpoint`: after every build phase, a short summary, code spots for Djordje to read, 3 questions answered one at a time and checked against the code, the README updated in Djordje's words, and an entry in this log.
  - `demo-preflight`: a read-only checklist before the demo (secrets, build, approval gate, live test, disclosure, backup video).
- **Adapty agent skills and MCP.** Adapty's official skills (`npx adapty skills install`) and the Adapty MCP server (`https://mcp.adapty.io/mcp`), used for reading the app's tests and metrics while building.
- **Permission deny rules** in [.claude/settings.json](.claude/settings.json). The coding agent cannot call any Adapty MCP write tool (27 tools, plus `apps_get`, which returns the secret key, and `feedback_send`), cannot run any Adapty CLI write command (51 commands, including `ab-tests stop`), and cannot read `.env`. Stops are run by a human.
- **Independent reviewer subagents.** Before key commits, a fresh Claude subagent that sees only the diff and SPEC.md (not the conversation) checks three things: can the agent bypass the gate, can the token leak, is the boundary right. A second fresh subagent re-computes the pitch numbers from the CSV alone; a number goes on a slide only if it agrees with the implementation. Reviewers never get `.env` or Adapty access. Each review is logged below.
- **Vir**, Djordje's own session-distillation CLI, can summarize sessions into this log.
- **Guard hook.** A `PreToolUse` hook ([.claude/hooks/guard.sh](.claude/hooks/guard.sh)) backs up the deny rules, which only match exact command prefixes. It parses every Bash command and denies Adapty write commands in any form (`npx adapty@…`, full paths, `bash -c`, `$(…)`, chains) plus `adapty apps get`, and denies `.env` access through Bash, Read, Grep, Glob, Edit and Write. If it cannot check a call, it denies it. Tested by [.claude/hooks/guard.test.sh](.claude/hooks/guard.test.sh). This is a client-side policy, not a security boundary: the real boundary is that only the Fulcrum process holds `ADAPTY_TOKEN` (see SPEC.md). Hardened over three rounds of automated security review (quoted values, `npx`/path/`bash -c` forms, variable and ANSI-C command words, `.env` globs and brace tricks), then deliberately stopped: a text-matching guard cannot fully parse shell. Known limits: a script file that calls `adapty`, and deliberate obfuscation.
- **Activity hook.** A `PostToolUse` hook ([.claude/hooks/ai-log.sh](.claude/hooks/ai-log.sh)) appends one JSON line per Edit, Write, MultiEdit or Bash call to [.ai-log/events.jsonl](.ai-log/events.jsonl): timestamp, tool, file path or the first 120 characters of the command, and a success flag. Secrets are redacted before writing (known token prefixes, `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*` values, auth headers and Bearer tokens, credentials in URLs, long random strings), and file contents and prompts are never logged. The log is public on purpose, as evidence. Tested by [.claude/hooks/ai-log.test.sh](.claude/hooks/ai-log.test.sh).

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
