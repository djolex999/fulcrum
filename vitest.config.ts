import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The live (irreversible) test only runs via `npm run test:live`.
    exclude: [...configDefaults.exclude, "tests/integration/throwaway-stop.test.ts"],
  },
});
