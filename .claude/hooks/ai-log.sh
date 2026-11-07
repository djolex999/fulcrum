#!/bin/bash
# PostToolUse hook: append one redacted JSON line per tool call to .ai-log/events.jsonl.
# Logs timestamp (Europe/Belgrade), tool name, file path or first 120 chars of the command,
# and a success flag. Never logs file contents or prompts. Always exits 0.

/usr/bin/env python3 -I -c '
import json, os, re, sys
from datetime import datetime
from zoneinfo import ZoneInfo

R = "[REDACTED]"
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
RULES = [
    # Explicit project secrets, any value form (fallback that cannot regress)
    (re.compile(r"(?:ADAPTY_TOKEN|ANTHROPIC_API_KEY)\s*=\s*\S*"), R),
    # Known token prefixes
    (re.compile(r"(?<![A-Za-z0-9])(?:secret_live_|public_live_|dev_live|sk-|ghp_|gho_|github_pat_|xox[bpas]-)\S*"), R),
    # Authorization / API key headers: keep the header name, drop the value (incl. "Bearer x")
    (re.compile(r"(?i)\b(authorization|proxy-authorization|x-api-key|api-key|cookie)\s*:\s*(?:(?:bearer|basic|token)\s+)?(?:\\*\x22[^\x22]*\x22|\\*\x27[^\x27]*\x27|[^\s\x22\x27\\]+)"), r"\1: " + R),
    (re.compile(r"(?i)\bbearer\s+(?:\\*\x22[^\x22]*\x22|\\*\x27[^\x27]*\x27|[^\s\x22\x27\\]+)"), "Bearer " + R),
    # NAME=value or NAME: value where NAME contains KEY/TOKEN/SECRET/PASSWORD/PASSWD/PWD/CREDENTIAL/AUTH
    (re.compile(r"(?i)\b([A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credential|auth)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(?:\\*\x22[^\x22]*\x22|\\*\x27[^\x27]*\x27|[^\s\x22\x27\\]+)"), r"\1\2" + R),
    # --token value / --api-key=value style flags
    (re.compile(r"(?i)(--?[a-z0-9-]*(?:key|token|secret|password|passwd|credential)[a-z0-9-]*)(?:=|\s+)(?!-)(?:\\*\x22[^\x22]*\x22|\\*\x27[^\x27]*\x27|[^\s\x22\x27\\]+)"), r"\1 " + R),
    # Credentials in URLs: scheme://user:pass@host
    (re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@"), r"\1" + R + "@"),
]
# Long random-looking strings (>= 32 chars of token alphabet, letters and digits mixed), except UUIDs
LONG = re.compile(r"[A-Za-z0-9_+=-]{32,}")

def _long(m):
    s = m.group(0)
    if UUID.match(s) or not (re.search(r"[A-Za-z]", s) and re.search(r"[0-9]", s)):
        return s
    return R

def redact(s):
    for pattern, repl in RULES:
        s = pattern.sub(repl, s)
    return LONG.sub(_long, s)

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
    os.makedirs(log_dir, mode=0o700, exist_ok=True)
    path = os.path.join(log_dir, "events.jsonl")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")
except Exception:
    pass
' 2>/dev/null

exit 0
