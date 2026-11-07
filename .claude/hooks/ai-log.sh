#!/bin/bash
# PostToolUse hook: append one redacted JSON line per tool call to .ai-log/events.jsonl.
# Logs timestamp (Europe/Belgrade), tool name, file path or first 120 chars of the command,
# and a success flag. Never logs file contents or prompts. Always exits 0.

/usr/bin/env python3 -I -c '
import json, os, re, sys
from datetime import datetime
from zoneinfo import ZoneInfo

SECRET = re.compile(
    r"(?<![A-Za-z0-9])(?:secret_live_|dev_live|sk-)\S*"
    r"|(?:ADAPTY_TOKEN|ANTHROPIC_API_KEY)=\S*"
)

def redact(s):
    return SECRET.sub("[REDACTED]", s)

try:
    event = json.load(sys.stdin)
    tool = str(event.get("tool_name", ""))
    tin = event.get("tool_input") or {}
    resp = event.get("tool_response")

    if tool == "Bash":
        # Redact the full command first, then truncate, so a secret cannot be split.
        target = redact(str(tin.get("command", "")))[:120]
    else:
        target = redact(str(tin.get("file_path", "")))

    success = True
    if isinstance(resp, dict):
        if resp.get("success") is False or resp.get("interrupted") is True:
            success = False

    line = {
        "ts": datetime.now(ZoneInfo("Europe/Belgrade")).isoformat(timespec="seconds"),
        "tool": tool,
        "target": target,
        "success": success,
    }

    root = os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()
    log_dir = os.path.join(root, ".ai-log")
    os.makedirs(log_dir, exist_ok=True)
    with open(os.path.join(log_dir, "events.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")
except Exception:
    pass
' 2>/dev/null

exit 0
