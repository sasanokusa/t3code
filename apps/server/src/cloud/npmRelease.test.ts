import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import { CLI_SELF_UPDATE_DISABLED_REASON } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as NpmRelease from "./npmRelease.ts";

const version = "0.1.5-nightly.20261030.1";

const noPublicRegistry = HttpClient.make(() =>
  Effect.die("a configured npm lookup must not fall back to public npm"),
);
// A fake npm on PATH decides whether npm counts as installed.
const makeService = Effect.fnUntraced(function* (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  publicRegistry: HttpClient.HttpClient = noPublicRegistry,
  npmInstalled = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const npmBin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-release-" });
  for (const name of ["npm", "npm.cmd"]) {
    yield* fs.writeFileString(path.join(npmBin, name), "", { mode: 0o755 });
  }
  return yield* NpmRelease.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    Effect.provideService(HttpClient.HttpClient, publicRegistry),
    Effect.provideService(HostProcess.Environment, {
      PATH: npmInstalled ? npmBin : "",
      PATHEXT: ".CMD",
    }),
  );
}, Effect.provide(NodeServices.layer));

// Hardened fork: the Update track must never learn about, or offer, an upstream `t3` release.
it.effect.each([
  { spec: version, npmInstalled: true },
  { spec: "nightly", npmInstalled: true },
  { spec: "latest", npmInstalled: false },
])("refuses $spec without running npm or reaching a registry", ({ spec, npmInstalled }) =>
  Effect.gen(function* () {
    const service = yield* makeService(
      () => Effect.die("npm must not run"),
      HttpClient.make(() => Effect.die("the public registry must not be fetched")),
      npmInstalled,
    );
    const error = yield* service.get({ spec }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(ServerNpmReleaseError);
    expect(error.reason).toBe(CLI_SELF_UPDATE_DISABLED_REASON);
  }),
);
