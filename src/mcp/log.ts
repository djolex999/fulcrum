import { redactSecrets } from "../safety/secrets.js";

/**
 * The single logging path. stdout is the MCP channel, so logs go to stderr only,
 * after redaction. `scrub` also strips the literal token value.
 */
export function createLogger(token: string) {
  const scrub = (text: string): string => {
    const withoutToken = token ? text.split(token).join("[REDACTED]") : text;
    return redactSecrets(withoutToken);
  };
  const log = (message: string): void => {
    process.stderr.write(`[fulcrum] ${scrub(message)}\n`);
  };
  return { log, scrub };
}
