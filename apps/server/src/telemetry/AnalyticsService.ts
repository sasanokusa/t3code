// Hardened fork: product analytics are removed. This service keeps the upstream interface so
// callers compile unchanged, but it never reads an identity, buffers an event or opens a
// connection. Upstream sent batches to ingest.t3.codes (then PostHog) every 10 seconds.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Whether the event was queued to send; always false in this fork. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<boolean>;

    readonly flush: Effect.Effect<void>;

    /** Upstream reported hashed account ids of this install's owners; a no-op here. */
    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

const disabled = AnalyticsService.of({
  // @effect-diagnostics-next-line effectFnOpportunity:off
  record: () => Effect.succeed(false),
  flush: Effect.void,
  // @effect-diagnostics-next-line effectFnOpportunity:off
  recordOwners: () => Effect.void,
});

/** @public */
export const make = Effect.succeed(disabled);

export const layer = Layer.succeed(AnalyticsService, disabled);
