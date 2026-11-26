// Hardened fork: upstream reports the hashed T3 Connect account and a random install id so
// installs can be linked to people. This fork reads and reports neither; only the types remain,
// because other modules still import them.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const TelemetryOwnerSource = Schema.Literals(["connect", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  readonly ownerId: string;
}

/** Reads nothing: this fork never collects owner ids. */
export const getServerOwners: Effect.Effect<ReadonlyArray<TelemetryOwner>> = Effect.succeed([]);
