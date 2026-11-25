// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  auditUpstream,
  dependencyNames,
  hostsIn,
  mergeUpstream,
  newestStableTag,
  parseMergeTree,
  renderAudit,
} from "./fork-sync.ts";

const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-"));
afterAll(() => NodeFS.rmSync(temp, { recursive: true, force: true }));

const run = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Fork Sync",
      "-c",
      "user.email=fork-sync@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );

const write = (root: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), content);
  }
};

// A fork that replaced one upstream file, deleted another and edited a third in place.
const makeRepo = (name: string, { conflict }: { conflict: boolean }) => {
  const root = NodePath.join(temp, name);
  NodeFS.mkdirSync(root);
  run(root, "init", "-q", "-b", "fork");
  write(root, {
    "apps/server/Analytics.ts": "send();\n",
    "apps/server/cache.json": "{}\n",
    "apps/server/shared.ts": "one\ntwo\nthree\n",
    "apps/web/package.json": JSON.stringify({ dependencies: { effect: "1" } }),
  });
  run(root, "add", ".");
  run(root, "commit", "-q", "-m", "base");

  run(root, "switch", "-q", "-c", "upstream");
  write(root, {
    "apps/server/Analytics.ts": "send();\nsendMore('https://ingest.example.org');\n",
    "apps/server/cache.json": '{"endpoint":"https://cache.example.org"}\n',
    "apps/server/shared.ts": conflict ? "one\nupstream\nthree\n" : "one\ntwo\nthree\nfour\n",
    "apps/web/package.json": JSON.stringify({ dependencies: { effect: "1", "left-pad": "1" } }),
  });
  run(root, "commit", "-q", "-am", "upstream");

  run(root, "switch", "-q", "fork");
  run(root, "rm", "-q", "apps/server/cache.json");
  write(root, {
    ".gitattributes":
      "apps/server/Analytics.ts merge=fork-ours\napps/server/cache.json merge=fork-ours\n",
    "apps/server/Analytics.ts": "// Hardened fork: no-op.\n",
    "apps/server/shared.ts": "one\nfork\nthree\n",
  });
  run(root, "add", ".");
  run(root, "commit", "-q", "-m", "fork");
  return root;
};

describe("fork-sync", () => {
  it("picks the newest stable release tag", () => {
    assert.strictEqual(
      newestStableTag(["v0.1.9", "v0.1.11", "v0.1.12-nightly.20261124.5209", "v0.1.10-preview.1"]),
      "v0.1.11",
    );
    assert.isUndefined(newestStableTag(["mobile-android-build/2.3.0/abc"]));
  });

  it("reads the tree and conflicted paths from merge-tree", () => {
    assert.deepStrictEqual(parseMergeTree("abc123\na.ts\nb.ts\n"), {
      tree: "abc123",
      conflicts: ["a.ts", "b.ts"],
    });
  });

  it("finds hosts and dependency names", () => {
    assert.deepStrictEqual(
      [...hostsIn("x https://Api.Example.org/v1 http://localhost:3773")],
      ["api.example.org"],
    );
    assert.deepStrictEqual(
      [
        ...dependencyNames(
          JSON.stringify({ dependencies: { a: "1" }, devDependencies: { b: "1" } }),
        ),
      ],
      ["a", "b"],
    );
  });

  it.effect("audits upstream without touching the checkout", () =>
    Effect.gen(function* () {
      const root = makeRepo("audit", { conflict: true });
      const audit = yield* auditUpstream(root, "upstream");
      assert.isFalse(audit.alreadyMerged);
      assert.deepStrictEqual(audit.conflicts, ["apps/server/shared.ts"]);
      assert.deepStrictEqual(audit.keptForkSide, ["apps/server/cache.json"]);
      assert.deepStrictEqual(audit.forkOwnedChangedUpstream, [
        "apps/server/Analytics.ts",
        "apps/server/cache.json",
      ]);
      assert.deepStrictEqual(audit.markedFilesChangedUpstream, []);
      assert.strictEqual(audit.markersAfter, audit.markersBefore);
      // The kept stub hides upstream's new ingest host; the deleted cache file hides its endpoint.
      assert.deepStrictEqual(audit.newHosts, []);
      assert.deepStrictEqual(audit.newDependencies, ["left-pad (apps/web/package.json)"]);
      assert.include(renderAudit(audit), "apps/server/shared.ts");
      assert.strictEqual(run(root, "status", "--porcelain"), "");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps fork-owned files and commits a merge with nothing left to resolve", () =>
    Effect.gen(function* () {
      const root = makeRepo("clean", { conflict: false });
      const result = yield* mergeUpstream(root, "upstream");
      assert.deepStrictEqual(result.conflicts, []);
      assert.strictEqual(result.branch, "sync/upstream");
      const read = (file: string) =>
        NodeFS.readFileSync(NodePath.join(result.worktree, file), "utf8");
      assert.strictEqual(read("apps/server/Analytics.ts"), "// Hardened fork: no-op.\n");
      assert.isFalse(NodeFS.existsSync(NodePath.join(result.worktree, "apps/server/cache.json")));
      assert.strictEqual(read("apps/server/shared.ts"), "one\nfork\nthree\nfour\n");
      assert.strictEqual(run(result.worktree, "status", "--porcelain"), "");
      assert.strictEqual(
        run(result.worktree, "log", "-1", "--format=%P").trim().split(" ").length,
        2,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops at real conflicts after settling fork-owned ones", () =>
    Effect.gen(function* () {
      const root = makeRepo("conflict", { conflict: true });
      const result = yield* mergeUpstream(root, "upstream");
      assert.deepStrictEqual(result.conflicts, ["apps/server/shared.ts"]);
      assert.deepStrictEqual(
        run(result.worktree, "diff", "--name-only", "--diff-filter=U").trim(),
        "apps/server/shared.ts",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
