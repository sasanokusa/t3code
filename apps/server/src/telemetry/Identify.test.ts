import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { getServerOwners } from "./Identify.ts";

// Hardened fork: no other tool's files are read and no owner ids are reported.
it.effect("reports no owners", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* getServerOwners, []);
  }),
);
