import { execFileSync } from "node:child_process";
import { scanForSecrets } from "../src/safety/secrets.js";

// Test files hold fake tokens on purpose.
const SKIP = [/^tests\//, /^\.claude\/hooks\/.*\.test\.sh$/];

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const files = git(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"])
  .split("\0")
  .filter((f) => f.length > 0 && !SKIP.some((re) => re.test(f)));

let hits = 0;
for (const file of files) {
  for (const rule of scanForSecrets(git(["show", `:${file}`]))) {
    console.error(`${file}: ${rule}`);
    hits++;
  }
}
process.exit(hits > 0 ? 1 : 0);
