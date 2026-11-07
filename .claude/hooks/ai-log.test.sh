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

# 1b. Broader secret shapes from the security review
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"curl -H \"Authorization: Bearer abcTOKEN999\" https://u:hunter2pw@x.io"},"tool_response":{}}' | "$HOOK"
line="$(tail -1 "$LOG")"
! grep -qE 'abcTOKEN999|hunter2pw' <<<"$line"; check "Bearer header and URL credentials are redacted" $?
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"MY_SECRET=s3cr3tv4lue x --password pw1234 && echo Zx9kQ2mP7vL4nR8tW1yB6cD3fG5hJ0sA"},"tool_response":{}}' | "$HOOK"
line="$(tail -1 "$LOG")"
! grep -qE 's3cr3tv4lue|pw1234|Zx9kQ2mP7vL4nR8tW1yB6cD3fG5hJ0sA' <<<"$line"; check "NAME=value, --password and long random strings are redacted" $?
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ADAPTY_TOKEN=\"qv1abc\" x && MY_KEY='"'"'qv2 with space'"'"' y && curl -H \"x-api-key: \\\"qv3\\\"\" --token \"qv4\""},"tool_response":{}}' | "$HOOK"
line="$(tail -1 "$LOG")"
! grep -qE 'qv1abc|qv2|qv3|qv4' <<<"$line"; check "quoted values are redacted" $?
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ADAPTY_TOKEN=\"qa1 qa2\" x && MY_KEY=qb1\"qb2\"qb3 y && API_TOKEN=qc1\\ qc2 z"},"tool_response":{}}' | "$HOOK"
line="$(tail -1 "$LOG")"
! grep -qE 'qa1|qa2|qb1|qb2|qb3|qc1|qc2' <<<"$line"; check "spaces in quotes, glued parts and escaped spaces are redacted" $?
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"adapty ab-tests list --app f8711513-c780-42b2-b6da-6c44094f3867"},"tool_response":{}}' | "$HOOK"
line="$(tail -1 "$LOG")"
grep -q 'f8711513-c780-42b2-b6da-6c44094f3867' <<<"$line"; check "UUIDs (app ids) are kept" $?
[ "$(stat -f %Lp "$LOG" 2>/dev/null || stat -c %a "$LOG")" = 600 ]; check "log file is mode 600" $?

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
