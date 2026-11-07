import { describe, expect, it } from "vitest";
import { backupChildEnv } from "../../scripts/backup-env.js";

describe("demo backup child environment", () => {
  it("forwards FULCRUM_PORT and nothing token-like", () => {
    process.env.ADAPTY_TOKEN = "secret-test-value";
    try {
      const env = backupChildEnv(8788);
      expect(env).toEqual({ FULCRUM_PORT: "8788" });
      expect(JSON.stringify(env)).not.toMatch(/token|secret/i);
    } finally {
      delete process.env.ADAPTY_TOKEN;
    }
  });
});
