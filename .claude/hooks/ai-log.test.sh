#!/bin/bash
# Test for ai-log.sh: secrets are redacted, contents are not logged, the hook never fails.
# Runs against a temporary project dir, so the real .ai-log/events.jsonl is untouched.
# Usage: bash .claude/hooks/ai-log.test.sh

HOOK="$(cd "$(dirname "$0")" && pwd)/ai-log.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export CLAUDE_PROJECT_DIR="$TMP"
LOG="$TMP/.ai-log/events.jsonl"
fail=0

check() { # name, condition result
  if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi
}

# 1. Bash event with fake secrets in the command
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"curl -H \"x-api-key: sk-test123\" --token secret_live_abc && ADAPTY_TOKEN=dev_live_xyz adapty ab-tests list && export ANTHROPIC_API_KEY=sk-ant-fake"},"tool_response":{"stdout":"ok","interrupted":false}}' | "$HOOK"
check "hook exits 0 on a Bash event" $?
line="$(tail -1 "$LOG" 2>/dev/null)"
! grep -qE 'secret_live_abc|sk-test123|dev_live_xyz|sk-ant-fake' <<<"$line"; check "secrets are not in the log line" $?
grep -q '\[REDACTED\]' <<<"$line"; check "secrets are replaced with [REDACTED]" $?
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert set(d)=={"ts","tool","target","success"} and d["tool"]=="Bash" and d["success"] is True and len(d["target"])<=120 and d["ts"].endswith(("+01:00","+02:00"))' "$line" 2>/dev/null
check "line has ts (Belgrade), tool, target <= 120 chars, success" $?

# 2. Write event: log the path only, never the content
printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"/repo/notes.md","content":"PRIVATE BODY secret_live_abc"},"tool_response":{"success":true}}' | "$HOOK"
line="$(tail -1 "$LOG")"
! grep -q 'PRIVATE BODY' <<<"$line"; check "file contents are not logged" $?
grep -q '"/repo/notes.md"' <<<"$line"; check "file path is logged" $?

# 3. Garbage input must not fail the tool call
printf 'not json' | "$HOOK"
check "hook exits 0 on invalid input" $?

[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail
