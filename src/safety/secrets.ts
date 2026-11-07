const RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: "adapty_token", pattern: /dev_live[A-Za-z0-9_]{6,}/ },
  { name: "adapty_secret", pattern: /secret_live_[A-Za-z0-9]+/ },
  { name: "env_assignment", pattern: /(ADAPTY_TOKEN|ANTHROPIC_API_KEY)=\S+/ },
];

/** Returns the names of the rules that match. Never returns the matched values. */
export function scanForSecrets(text: string): string[] {
  return RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
}
