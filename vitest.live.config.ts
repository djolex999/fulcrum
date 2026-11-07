import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/throwaway-stop.test.ts", "tests/integration/throwaway-create.test.ts"],
  },
});
