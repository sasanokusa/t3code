import { describe, expect, it, vi } from "vite-plus/test";

import { installMainWindowEgressBlockPolicy } from "./EgressBlockPolicy.ts";

describe("installMainWindowEgressBlockPolicy", () => {
  it("cancels every request to T3-owned and telemetry hosts", () => {
    const onBeforeRequest = vi.fn();
    const detach = installMainWindowEgressBlockPolicy({ webRequest: { onBeforeRequest } } as never);

    const [filter, listener] = onBeforeRequest.mock.calls[0]!;
    expect(filter.urls).toEqual(
      expect.arrayContaining(["*://t3.codes/*", "*://*.t3.codes/*", "*://*.posthog.com/*"]),
    );
    const callback = vi.fn();
    listener({ url: "https://relay.t3.codes/v1" }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });

    detach();
    expect(onBeforeRequest).toHaveBeenLastCalledWith(null);
  });
});
