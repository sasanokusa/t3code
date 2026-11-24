import { describe, expect, it } from "@effect/vitest";

import {
  blockedEgressSuffix,
  EgressBlockedError,
  guardFetch,
  guardWebSocket,
  parseEgressAllowList,
} from "./egressPolicy.ts";

describe("egressPolicy", () => {
  it("blocks T3 and telemetry hosts and their subdomains only", () => {
    expect(blockedEgressSuffix("https://relay.t3.codes/v1/x")).toBe("t3.codes");
    expect(blockedEgressSuffix("https://ingest.t3.codes/batch/")).toBe("t3.codes");
    expect(blockedEgressSuffix("https://us.i.posthog.com/e")).toBe("posthog.com");
    expect(blockedEgressSuffix("https://api.axiom.co/v1/traces")).toBe("axiom.co");
    expect(blockedEgressSuffix("wss://clerk.t3.codes./x")).toBe("t3.codes");
    expect(blockedEgressSuffix("https://not-t3.codes.example.com/")).toBeUndefined();
    expect(blockedEgressSuffix("https://saserver.tailnet.ts.net/relay")).toBeUndefined();
    expect(blockedEgressSuffix("not a url")).toBeUndefined();
  });

  it("lets explicitly allowed hosts through", () => {
    const allow = parseEgressAllowList(" app.t3.codes , ");
    expect(blockedEgressSuffix("https://app.t3.codes/pair", allow)).toBeUndefined();
    expect(blockedEgressSuffix("https://relay.t3.codes/", allow)).toBe("t3.codes");
  });

  it("refuses blocked fetches before calling the wrapped fetch", async () => {
    const calls: Array<string> = [];
    const fetchImpl = async (input: string) => {
      calls.push(input);
      return "ok";
    };
    const guarded = guardFetch(fetchImpl);
    await expect(guarded("https://ingest.t3.codes/batch/")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    await expect(guarded("https://example.com/")).resolves.toBe("ok");
    expect(calls).toEqual(["https://example.com/"]);
  });

  it("refuses sockets to blocked hosts", () => {
    class FakeSocket {
      readonly url: string | URL;
      constructor(url: string | URL) {
        this.url = url;
      }
    }
    const Guarded = guardWebSocket(FakeSocket);
    expect(() => new Guarded("wss://relay.t3.codes/ws")).toThrow(EgressBlockedError);
    expect(new Guarded("wss://example.com/ws").url).toBe("wss://example.com/ws");
  });
});
