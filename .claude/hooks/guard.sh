#!/bin/bash
# PreToolUse guard. Blocks, for the coding agent:
#   - Adapty write commands in any form (adapty, npx adapty@x, /path/to/adapty, bash -c "...",
#     $(...), backticks), plus `adapty apps get` (returns the secret key)
#   - any access to .env files through Bash, Grep, Read, Edit or Write (.env.example is allowed)
# This is a client-side policy, not a security boundary: a script file that calls adapty is not
# inspected. The real boundary is that only the Fulcrum process holds ADAPTY_TOKEN (SPEC.md).
# Fails closed: if the input cannot be checked, the tool call is denied.

/usr/bin/env python3 -I -c '
import json, os, re, shlex, sys

WRITE = {"archive", "create", "replace", "start", "stop", "update", "publish", "upload", "push",
         "set", "run", "close", "add", "connect", "revoke", "bulk-create", "sync", "feedback",
         "edit", "delete", "remove"}
SEP = {";", "&&", "||", "|", "&", "(", ")", "|&", ";;", "\n"}
ENV_SAFE_FIRST = {"ls", "stat", "test", "["}
ENV_SAFE_GIT = {"check-ignore", "status", "ls-files"}
ENV_FILE = re.compile(r"(?:^|/)\.env(?:\.(?!example$)[A-Za-z0-9_-]+)?$")

def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
          "permissionDecision": "deny", "permissionDecisionReason": "Fulcrum guard: " + reason}}))
    sys.exit(0)

def tokens(cmd):
    try:
        lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        lex.commenters = ""
        return [t.strip("`") for t in lex]
    except ValueError:
        # Unbalanced quotes (e.g. an apostrophe in a heredoc): fall back to a plain split
        # that drops quotes, so the call is still checked instead of blindly denied.
        flat = re.sub(r"[\x22\x27`]", " ", cmd)
        flat = re.sub(r"(&&|\|\||[;|&()])", r" \1 ", flat)
        return flat.split()

def segments(toks):
    seg = []
    for t in toks:
        if t in SEP or (t and set(t) <= set(";&|()")):
            if seg: yield seg
            seg = []
        else:
            seg.append(t)
    if seg: yield seg

def is_adapty(t):
    base = os.path.basename(t.split("@", 1)[0]) if not t.startswith("@") else t
    return base == "adapty" or "adapty/bin" in t

def check_cmd(cmd, depth=0):
    if depth > 3:
        deny("command nesting too deep to check")
    toks = tokens(cmd)
    for seg in segments(toks):
        # Nested shells: bash -c "...", sh -c, eval "...", and any quoted token with spaces
        for t in seg:
            if " " in t or "$(" in t:
                check_cmd(t.replace("$(", " ( "), depth + 1)
        # Adapty write commands
        for i, t in enumerate(seg):
            if is_adapty(t):
                rest = seg[i + 1:]
                if "--help" in rest or "-h" in rest:
                    continue
                words = [w for w in rest if not w.startswith("-")]
                hit = sorted(set(words) & WRITE)
                if hit:
                    deny("Adapty write command (" + ", ".join(hit) + ") is blocked for the agent. "
                         "Writes go through the Fulcrum approval gate, or a human runs them.")
                if "apps" in words and "get" in words:
                    deny("`adapty apps get` returns the app secret key and is blocked.")
        # .env access
        first = os.path.basename(seg[0]) if seg else ""
        safe = first in ENV_SAFE_FIRST or (first == "git" and len(seg) > 1 and seg[1] in ENV_SAFE_GIT)
        if not safe:
            for t in seg:
                for part in re.split(r"[=<>]", t):
                    if ENV_FILE.search(part.rstrip("/")):
                        deny("access to " + part + " is blocked (secrets live there).")

try:
    event = json.load(sys.stdin)
    tool = event.get("tool_name", "")
    tin = event.get("tool_input") or {}
    if tool == "Bash":
        check_cmd(str(tin.get("command", "")))
    else:
        for key in ("file_path", "path", "glob", "pattern" if tool == "Glob" else ""):
            v = str(tin.get(key, "")) if key else ""
            if v and ENV_FILE.search(v.rstrip("/")):
                deny("access to " + v + " is blocked (secrets live there).")
except SystemExit:
    raise
except Exception as e:
    deny("could not check this call (" + type(e).__name__ + "), denied to be safe.")
'
exit 0
