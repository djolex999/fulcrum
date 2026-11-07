import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../../src/safety/secrets.js";

describe("scanForSecrets", () => {
  it("flags an Anthropic key", () => {
    expect(scanForSecrets("key sk-ant-api03-abcdefghij")).toContain("anthropic_key");
  });
  it("flags an Adapty token", () => {
    expect(scanForSecrets("ADAPTY_TOKEN=dev_live_abc123")).toContain("adapty_token");
  });
  it("flags an Adapty secret", () => {
    expect(scanForSecrets("secret_live_xyz")).toContain("adapty_secret");
  });
  it("ignores a plain UUID", () => {
    expect(scanForSecrets("app id f8711513-c780-42b2-b6da-6c44094f3867")).toEqual([]);
  });
});
