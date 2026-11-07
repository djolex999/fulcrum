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
- **Activity hook.** A `PostToolUse` hook ([.claude/hooks/ai-log.sh](.claude/hooks/ai-log.sh)) appends one JSON line per Edit, Write, MultiEdit or Bash call to a local, gitignored `.ai-log/events.jsonl`: timestamp, tool, file path or the first 120 characters of the command, and a success flag. Secrets are redacted before writing (known token prefixes, `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*` values, auth headers and Bearer tokens, credentials in URLs, long random strings), and file contents and prompts are never logged. The raw log stays on the developer's machine (it is gitignored); this file is the public summary. Tested by [.claude/hooks/ai-log.test.sh](.claude/hooks/ai-log.test.sh).

## Independent reviews

### Cross-check 1: pitch numbers from raw data (Sat 7 Nov, ~12:05)

- **Who:** a fresh Claude subagent with no project context. It could read only the offline CSVs and `flows/*.json` of the public Lumen dataset; it was told not to read this repo, the spec or our notes, and got none of our numbers. It ran nothing from the dataset repo. Its report is kept locally.
- **Method (its own):** arm = `flow` within `ab_test`; RPI = net revenue (refunds subtracted at refund time) within D days of install over all installs, only users with the full D days; Welch test on per-user values; looks every 7 days from the first install, K = 15, boundary 2.1 × sqrt(15/k).
- **Agrees:**
  - Onboarding first crosses the boundary at **week 9** (z ≈ −4.5 against 2.71); weekly-first wins.
  - Settings at the end: difference **$1.57**, **p = 0.067**, the other arm leads.
- **Roughly agrees:** extra revenue from shipping Onboarding at week 9 is **≈ $19.4k** by its age-curve method (our estimate: ≈ $21k). The simple "users × D60 gap" approximation gives ≈ $27k, which overstates it.
- **Differs:**
  - Settings **as of 2026-09-02**: it finds −$1.37, **p = 0.26** on revenue to date (and the leader flips at a fixed 30-day horizon, p = 0.56). Our estimate was +$2.48, p ≈ 0.049. **Unresolved:** the result depends on the RPI definition and horizon. The implementation must reproduce a stated definition before this goes in the demo.
  - Onboarding RPI gap: ≈ $4.05 at D60 (our note said +$3.63 without a horizon).
- **Action:** pitch numbers stay [estimate] until the implementation's AC-1/AC-2 tests produce them; use "≈ $20k" until then.

### Cross-check 2: the Settings timeline (Sat 7 Nov, ~12:25, Fable)

- **Who:** a fresh subagent on Fable with the same isolation as cross-check 1. It was told only that Adapty shows Settings as completed with `settings` declared the winner.
- **Asked:** at every weekly look and on five metrics (revenue to date, 7/14/30-day RPI, payer rate), did `settings` ever lead with naive p < 0.05, and was the boundary ever crossed?
- **Found:** exactly one naive-significant `settings` lead, 16 Aug on 30-day RPI (p ≈ 0.044, boundary 3.3 to 3.5, not crossed). It is fragile (permutation p = 0.052, below 0.05 on 2 of 27 days). The boundary was **never crossed for `settings`**; at the end `main_lifetime` leads on all five metrics, decisively on payer rate (24.4% vs 17.1%). The arms also sell different products, so it is not a clean anchor test.
- **What we changed because of it:** we dropped the "Settings as of 2 Sep" demo centerpiece. Settings is now "the mistake already in the dashboard" (robust end state and full timeline), and the "not yet, then now" moment moved to Onboarding. See the [demo design](docs/superpowers/specs/2026-11-07-fulcrum-demo-design.md).

### Builder check of the demo design (Sat 7 Nov, ~12:40, Sonnet)

- **Who:** a fresh subagent on Sonnet that read only the design document and was asked what it would still need before it could plan the build.
- **Found:** 8 questions: contracts, data and CLI shape, the week 2 and week 9 cutoffs, calibration, approval security, the Settings "promote" wording, the pre-commit hook, and what is optional.
- **What we changed:** we answered all 8 in the design doc. Four were decided as marked calls: the live stop is judged on the CSV, c is precomputed by simulation, the Settings goal is revenue per install to date, and the approval page re-checks the verdict when someone approves and executes at most once. Nothing needed a new decision from Djordje before planning.

### Gate review (Task 3, Sat 7 Nov, ~13:40, Fable + security plugin)

- **Who:** a fresh Fable subagent that saw only the task brief, the diff and SPEC.md's gate invariants, asked three questions: can the agent bypass the gate, can a secret leak, is the ledger append-only. An automated security review of the commit ran in parallel.
- **Found:** no bypass (`stopTest` has one call site, after a named human approval; concurrent approvals execute once), no leak (every stored reason redacted). Three Important issues: concurrent requests for one test could create two pending actions (both reviewers found it; Fable reproduced it with two stops), the action became approvable before its ledger entry was written, and the judge's codes (`BEFORE_HORIZON`, `METRIC_NOT_GOAL`) never reached `request_stop`.
- **What we changed:** the test slot is reserved before any await, the ledger is written first, and `request_stop` carries the judge's verdict and code (SPEC.md overruled the plan's wording). A Fable re-review confirmed all three fixed; the remaining observations are logged as known limits for the final review.

### MCP server review (Task 9, Sat 7 Nov, ~14:20, Fable)

- **Who:** a fresh Fable subagent with only the task brief, the diff and SPEC.md, asked whether the agent can bypass the gate through the server, whether the token can leak, whether stdout stays clean, and whether SPEC.md matches the code.
- **Found:** no bypass (the server only gets the CLI's read methods at the type level; five tools, no approve tool, verified over real stdio), no leak (one scrub path for results, errors and logs; a smoke run with a fake token showed it nowhere), stdout carries only JSON-RPC. Approved with minor findings: error labelling for stats crashes, the wording of the in-progress result, sharing one judge between the gate and the tools. These are carried into the next wiring task.

### Approval page reviews (Task 10, Sat 7 Nov, ~14:30–15:00, Sonnet + Fable + security plugin)

- **Found:** the first version stopped browsers from approving, but **not the agent itself**: an agent with Bash could approve its own request with `curl` (no Origin header). The automated security review rated it high; the Sonnet review agreed. Later rounds found the login link was reusable and equal to the cookie value, cookies are sent to every localhost port, and the guard regex missed loopback variants.
- **What we changed (two fix rounds):** the page now needs a session that only the human's browser can get: Fulcrum opens the browser with a single-use login code (60 s), the cookie is a fresh random session id, every form carries a session-bound CSRF token, POSTs need an allowed Origin, plus a Host allowlist, frame headers, and the browser opens only after the server listens. The guard hook also denies any agent command aimed at the approval port. A Fable re-review was cut off by the model's safety filter partway through (it had already confirmed round 1); the final re-review ran on Sonnet and found nothing open.
- **Known limit, said openly:** on the same OS user, a determined local process could still see the one-time code in the `open` arguments during its 60 s window, or read browser state. Production approval would use a separate channel (Slack, email, another OS user).

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
