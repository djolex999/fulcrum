#!/bin/bash
# Test for guard.sh: Adapty writes and .env access are denied in any form, reads are allowed.
# Usage: bash .claude/hooks/guard.test.sh

HOOK="$(cd "$(dirname "$0")" && pwd)/guard.sh"
fail=0

run() { # tool, json tool_input -> prints "deny" or "allow"
  out="$(printf '{"tool_name":"%s","tool_input":%s}' "$1" "$2" | "$HOOK")"
  grep -q '"permissionDecision": "deny"' <<<"$out" && echo deny || echo allow
}
expect() { # expected, name, tool, json
  got="$(run "$3" "$4")"
  if [ "$got" = "$1" ]; then echo "PASS  $1   $2"; else echo "FAIL  $1   $2 (got $got)"; fail=1; fi
}
bash_cmd() { python3 -c 'import json,sys; print(json.dumps({"command": sys.argv[1]}))' "$1"; }

A=f8711513-c780-42b2-b6da-6c44094f3867
# Adapty writes: denied in every form
expect deny  "adapty ab-tests stop"              Bash "$(bash_cmd "adapty ab-tests stop X --app $A --winner Y")"
expect deny  "npx adapty@0.18.0 ab-tests stop"   Bash "$(bash_cmd "npx --yes adapty@0.18.0 ab-tests stop X --app $A")"
expect deny  "full path to adapty"               Bash "$(bash_cmd "/opt/homebrew/bin/adapty flows publish F")"
expect deny  "bash -c wrapper"                   Bash "$(bash_cmd "bash -c 'adapty ab-tests start X --app $A'")"
expect deny  "after && in a chain"               Bash "$(bash_cmd "cd /tmp && adapty placements update P")"
expect deny  "inside \$(...)"                    Bash "$(bash_cmd 'echo $(adapty products push)')"
expect deny  "env prefix"                        Bash "$(bash_cmd "ADAPTY_TOKEN=x adapty ab-tests archive X")"
expect deny  "adapty apps get (secret key)"      Bash "$(bash_cmd "adapty apps get $A")"
# Adapty reads: allowed
expect allow "adapty ab-tests list"              Bash "$(bash_cmd "adapty ab-tests list --app $A --json")"
expect allow "adapty ab-tests metrics total"     Bash "$(bash_cmd "adapty ab-tests metrics total X --app $A")"
expect allow "adapty ab-tests stop --help"       Bash "$(bash_cmd "adapty ab-tests stop --help")"
# Dynamic command names next to adapty (review round 2)
expect deny  "\$CMD with adapty"                 Bash "$(bash_cmd 'C=adapty; $C ab-tests stop X')"
expect deny  "eval with adapty"                  Bash "$(bash_cmd 'eval "ada""pty ab-tests stop X"')"
expect deny  "xargs with adapty"                 Bash "$(bash_cmd 'echo stop | xargs adapty ab-tests')"
expect deny  "pipe into sh with adapty"          Bash "$(bash_cmd 'echo "adapty ab-tests stop X" | sh')"
expect allow "read with \$APP variable"          Bash "$(bash_cmd 'adapty ab-tests list --app $APP --json')"
# Parser tricks (review round 3)
expect deny  "split quotes ad''apty"             Bash "$(bash_cmd "ad''apty ab-tests stop X")"
expect deny  "ANSI-C \$'...' command"            Bash "$(bash_cmd "\$'\\x61dapty' ab-tests stop X")"
expect deny  "\${X} as command word"             Bash "$(bash_cmd 'X=adapty; ${X} ab-tests stop Y')"
expect deny  "\$(...) as command word"           Bash "$(bash_cmd '$(echo adapty) ab-tests stop Y')"
expect deny  ".e{n,}v brace trick"               Bash "$(bash_cmd "cat .e{n,}v")"
expect deny  "ANSI-C .env"                       Bash "$(bash_cmd "cat \$'\\x2eenv'")"
# .env: denied through Bash and file tools, .env.example allowed
expect deny  "glob .e* in Bash"                  Bash "$(bash_cmd "cat .e*")"
expect deny  "glob .??v in Bash"                 Bash "$(bash_cmd "head .??v")"
expect deny  "brace {.env,x} in Bash"            Bash "$(bash_cmd "cat {.env,README.md}")"
expect deny  "Glob tool pattern .e*"             Glob '{"pattern":".e*"}'
expect allow "process.env in a grep"             Bash "$(bash_cmd "grep -rn process.env src")"
expect allow "cat * (shell skips dotfiles)"      Bash "$(bash_cmd "cat *.md")"
expect deny  "cat .env"                          Bash "$(bash_cmd "cat .env")"
expect deny  "source ./.env"                     Bash "$(bash_cmd "source ./.env && npm run dev")"
expect deny  "grep in .env.local"                Bash "$(bash_cmd "grep KEY .env.local")"
expect deny  "redirect from .env"                Bash "$(bash_cmd "python3 x.py < .env")"
expect deny  "Read tool on absolute .env"        Read '{"file_path":"/Users/x/projects/fulcrum/.env"}'
expect deny  "Grep tool on .env"                 Grep '{"pattern":"KEY","path":".env"}'
expect allow "cat .env.example"                  Bash "$(bash_cmd "cat .env.example")"
expect allow "git check-ignore .env"             Bash "$(bash_cmd "git check-ignore -v .env")"
expect allow "ls -l .env"                        Bash "$(bash_cmd "ls -l .env")"
# Ordinary work: allowed
expect allow "npm run build"                     Bash "$(bash_cmd "npm run build && npx vitest run")"
expect allow "Edit a source file"                Edit '{"file_path":"/Users/x/projects/fulcrum/src/gate.ts"}'
expect allow "heredoc with an apostrophe"        Bash "$(bash_cmd "git commit -F - <<EOF
Don't block this
EOF")"
expect deny  "unbalanced quote still checked"    Bash "$(bash_cmd "echo it's && adapty ab-tests stop X")"
# Fail closed
out="$(printf 'not json' | "$HOOK")"; grep -q deny <<<"$out" && echo "PASS  deny   invalid input fails closed" || { echo "FAIL  invalid input fails closed"; fail=1; }

# Approval page is for humans only
expect deny  "curl POST to approval page"        Bash "$(bash_cmd "curl -X POST http://127.0.0.1:8787/approve/x -d name=a")"
expect deny  "curl localhost ledger"             Bash "$(bash_cmd "curl localhost:8787/ledger")"
expect deny  "curl 0.0.0.0 port"                 Bash "$(bash_cmd "curl http://0.0.0.0:8787/")"
expect deny  "curl 127.1 short form"             Bash "$(bash_cmd "curl 127.1:8787/ledger")"
expect deny  "nc to the port"                    Bash "$(bash_cmd "nc 127.0.0.1 8787")"
expect deny  "port via variable path /reject/"   Bash "$(bash_cmd 'curl -X POST http://127.0.0.1:$PORT/reject/x')"
expect deny  "login path"                        Bash "$(bash_cmd 'curl http://127.0.0.1:$PORT/login')"
expect allow "npm test"                          Bash "$(bash_cmd "npm test")"

[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail
