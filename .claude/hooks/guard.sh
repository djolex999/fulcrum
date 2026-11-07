#!/bin/bash
# PreToolUse guard. Blocks, for the coding agent:
#   - Adapty write commands in any form (adapty, npx adapty@x, /path/to/adapty, bash -c "...",
#     $(...), backticks), plus `adapty apps get` (returns the secret key)
#   - any access to .env files through Bash, Grep, Read, Edit or Write (.env.example is allowed)
# This is a client-side policy, not a security boundary: a script file that calls adapty is not
# inspected. The real boundary is that only the Fulcrum process holds ADAPTY_TOKEN (SPEC.md).
# Fails closed: if the input cannot be checked, the tool call is denied.

/usr/bin/env python3 -I -c '
import fnmatch, json, os, re, shlex, sys

WRITE = {"archive", "create", "replace", "start", "stop", "update", "publish", "upload", "push",
         "set", "run", "close", "add", "connect", "revoke", "bulk-create", "sync", "feedback",
         "edit", "delete", "remove"}
SEP = {";", "&&", "||", "|", "&", "(", ")", "|&", ";;", "\n"}
ENV_SAFE_FIRST = {"ls", "stat", "test", "["}
ENV_SAFE_GIT = {"check-ignore", "status", "ls-files"}
ENV_FILE = re.compile(r"(?:^|/)\.env(?:\.(?!example$)[A-Za-z0-9_-]+)?$")
# .env anywhere in a token ({.env,x}, "./.env", .env.local), but not .env.example or process.env
ENV_ANY = re.compile(r"(?<![A-Za-z0-9_])\.env(?![A-Za-z0-9_]|\.example(?![A-Za-z0-9_.]))")

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

PROJECT_DIR = os.environ.get("CLAUDE_PROJECT_DIR", "").rstrip("/")
DEMO = PROJECT_DIR.endswith("/demo")
REPO_ROOT = os.path.dirname(PROJECT_DIR) if DEMO else ""
# Demo agent only: write-shaped commands that reach outside demo/ (Fulcrum code, guard, settings).
WRITE_SHAPE = re.compile(r"(?<![0-9&])>(?!&|\s*/dev/null)|(?<![A-Za-z0-9_./-])(tee|cp|mv|rm|rmdir|chmod|chown|ln|install|dd|truncate|touch|mkdir|patch|rsync|perl|ed|ex|vi|vim|nano)(?![A-Za-z0-9_-])"
                         r"|sed\s+(-[A-Za-z]*i|--in-place)|git\s+(checkout|restore|apply|reset|clean|stash|mv|rm|am|merge|rebase|pull)"
                         r"|(npm|pnpm|yarn)\s+(install|i|ci|add|uninstall|remove|rm|update)|npx\b.*\binstall\b")

def check_demo_tamper(cmd):
    outside = re.search(r"\.\./|\.\.(?=\s|$|[;&|)])", cmd) or (REPO_ROOT and REPO_ROOT in cmd)
    if re.search(r"\.claude|\.mcp\.json|CLAUDE\.md", cmd) and WRITE_SHAPE.search(cmd):
        deny("the demo agent may not modify its own policy files (.claude, .mcp.json, CLAUDE.md).")
    if outside and WRITE_SHAPE.search(cmd):
        deny("the demo agent may not write outside demo/ (Fulcrum code, guard and settings are off limits).")

def check_cmd(cmd, depth=0):
    if depth > 3:
        deny("command nesting too deep to check")
    if re.search(r"8787|/approve/|/reject/|/login", cmd):
        deny("the approval page is for humans only")
    toks = tokens(cmd)
    mentions_adapty = "adapty" in cmd or "adapty" in "".join(toks)
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
        # A command word built from expansion ($CMD, ${X}, $(...)) or ANSI-C quoting cannot be checked
        cw = [t for t in seg if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t)]
        if cw and (cw[0].startswith("$") or "${" in cw[0] or "$(" in cw[0]):
            deny("the command word " + cw[0] + " comes from an expansion and cannot be checked.")
        if any("$\x27" in t or t.startswith("$\x27") for t in seg) or "$\x27" in cmd:
            deny("ANSI-C quoting ($\x27...\x27) cannot be checked.")
        # Dynamic command names next to adapty: eval, xargs, a pipe into sh/bash
        if mentions_adapty:
            cmd_words = [t for t in seg if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t)]
            head = cmd_words[0] if cmd_words else ""
            if head.startswith("$") or os.path.basename(head) in {"eval", "xargs", "env", "exec", "source", "."} \
               or (os.path.basename(head) in {"sh", "bash", "zsh"} and "-c" not in cmd_words):
                deny("a dynamic command (" + head + ") in a command that mentions adapty cannot be checked.")
        # .env access
        first = os.path.basename(seg[0]) if seg else ""
        safe = first in ENV_SAFE_FIRST or (first == "git" and len(seg) > 1 and seg[1] in ENV_SAFE_GIT)
        if not safe:
            for t in seg:
                if re.search(r"(?:^|/|[\x22\x27{,])\.e", t) and re.search(r"[{$\\]", t):
                    deny("the token " + t + " mixes .e with shell expansion and could reach .env.")
                if ENV_ANY.search(t):
                    deny("access to " + t + " is blocked (secrets live there).")
                base = os.path.basename(t)
                if base.startswith(".") and re.search(r"[*?\[]", base) and \
                   any(fnmatch.fnmatchcase(n, base) for n in (".env", ".env.local", ".env.production")):
                    deny("the pattern " + t + " can match .env and is blocked.")

try:
    event = json.load(sys.stdin)
    tool = event.get("tool_name", "")
    tin = event.get("tool_input") or {}
    if tool == "Bash":
        if DEMO:
            check_demo_tamper(str(tin.get("command", "")))
        check_cmd(str(tin.get("command", "")))
    else:
        for key in ("file_path", "path", "glob", "pattern" if tool == "Glob" else ""):
            v = str(tin.get(key, "")) if key else ""
            if v and (ENV_FILE.search(v.rstrip("/")) or ENV_ANY.search(v)):
                deny("access to " + v + " is blocked (secrets live there).")
            b = os.path.basename(v)
            if v and b.startswith(".") and re.search(r"[*?\[]", b) and \
               any(fnmatch.fnmatchcase(n, b) for n in (".env", ".env.local")):
                deny("the pattern " + v + " can match .env and is blocked.")
except SystemExit:
    raise
except Exception as e:
    deny("could not check this call (" + type(e).__name__ + "), denied to be safe.")
'
exit 0
