import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

// Hardened fork: analytics are a no-op, so nothing is ever queued to send.
it.effect("never queues an event", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    assert.isFalse(yield* analytics.record("thread.created", { provider: "codex" }));
    yield* analytics.recordOwners([{ source: "device", ownerId: "device-1" }], "server");
    yield* analytics.flush;
  }).pipe(Effect.provide(AnalyticsService.layer)),
);
