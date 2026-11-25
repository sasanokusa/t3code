import { expect, it, vi } from "vite-plus/test";

import * as Tracing from "./tracing";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

// Hardened fork: no traces URL is configured by default, so tracing stays off.
it("leaves tracing off without explicit configuration", () => {
  expect(Tracing.resolveTracingConfig()).toBeNull();
});
