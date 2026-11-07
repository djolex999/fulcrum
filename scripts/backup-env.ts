// The environment the backup script gives its Fulcrum child. Only the port: the SDK adds its own safe defaults,
// and spreading process.env would leak an exported ADAPTY_TOKEN (Fulcrum reads the token from .env itself).
export function backupChildEnv(port: number): Record<string, string> {
  return { FULCRUM_PORT: String(port) };
}
