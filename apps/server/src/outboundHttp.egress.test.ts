import { EgressBlockedError } from "@t3tools/shared/egressPolicy";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import { installEgressGuard } from "./outboundHttp.ts";

it.effect("refuses T3 hosts through the server's own HttpClient before any connection", () =>
  Effect.gen(function* () {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const reached: Array<string> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      reached.push(String(input instanceof Request ? input.url : input));
      return new Response("ok");
    }) as typeof fetch;
    const env: NodeJS.ProcessEnv = {};
    installEgressGuard(env);
    try {
      const blocked = yield* HttpClient.get("https://relay.t3.codes/v1/environments").pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(blocked));
      assert.include(Exit.isFailure(blocked) ? Cause.pretty(blocked.cause) : "", "egress policy");
      const allowed = yield* HttpClient.get("https://example.com/ok").pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(allowed));
      assert.deepEqual(reached, ["https://example.com/ok"]);
      assert.equal(env.DO_NOT_TRACK, "1");
      assert.equal(env.DISABLE_TELEMETRY, "1");
      assert.isTrue(new EgressBlockedError("x") instanceof TypeError);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    }
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
