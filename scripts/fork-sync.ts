#!/usr/bin/env node
// Hardened fork: checks an upstream release before it is merged into this fork, and merges it on a
// throwaway branch in a worktree next to this checkout. See docs/fork/HARDENING.md.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ForkSyncError extends Schema.TaggedError<ForkSyncError>()("ForkSyncError", {
  message: Schema.String,
}) {}

const MARKER = "Hardened fork";
// Files listed with this attribute in .gitattributes keep the fork's side of every merge.
const FORK_OURS = [
  "-c",
  "merge.fork-ours.name=keep the fork's side",
  "-c",
  "merge.fork-ours.driver=true",
];
const SOURCE_PATHSPECS = [
  "apps",
  "packages",
  "scripts",
  ":(exclude)apps/marketing",
  ":(exclude,glob)**/*.test.*",
  ":(exclude,glob)**/test/**",
  ":(exclude,glob)**/__tests__/**",
  ":(exclude,glob)**/fixtures/**",
  ":(exclude,glob)**/translations/**",
  ":(exclude,glob)**/*.md",
];
const TELEMETRY_PATH =
  /telemetry|observability|analytics|tracing|identify|posthog|sentry|axiom|datadog/i;
const TEST_PATH = /\.test\.[cm]?[jt]sx?$|(^|\/)(test|__tests__|fixtures)\//;

const collectText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks).toString()));

export const git = Effect.fn("forkSync.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  okExitCodes: ReadonlyArray<number> = [0],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-c", "core.quotePath=false", ...args], { cwd }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collectText(handle.stdout), collectText(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      if (!okExitCodes.includes(Number(exitCode))) {
        return yield* new ForkSyncError({
          message: `git ${args.join(" ")} exited with ${String(exitCode)}: ${stderr.trim()}`,
        });
      }
      return { stdout, exitCode: Number(exitCode) };
    }),
  );
});

const gitLines = (cwd: string, args: ReadonlyArray<string>, okExitCodes?: ReadonlyArray<number>) =>
  git(cwd, args, okExitCodes).pipe(
    Effect.map(({ stdout }) => stdout.split("\n").filter((line) => line.length > 0)),
  );

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The highest `vX.Y.Z` tag; nightly and preview tags are skipped. */
export const newestStableTag = (tags: ReadonlyArray<string>) =>
  tags
    .flatMap((tag) => {
      const match = STABLE_TAG.exec(tag);
      return match ? [{ tag, version: match.slice(1).map(Number) }] : [];
    })
    .sort((a, b) => a.version.reduce((order, part, i) => order || part - b.version[i]!, 0))
    .at(-1)?.tag;

/** `git merge-tree --write-tree --name-only --no-messages` prints the tree, then conflicted paths. */
export const parseMergeTree = (stdout: string) => {
  const [tree = "", ...paths] = stdout.split("\n");
  return { tree: tree.trim(), conflicts: paths.map((path) => path.trim()).filter(Boolean) };
};

export const hostsIn = (text: string) =>
  new Set(
    Array.from(text.matchAll(/https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g), (match) =>
      match[1]!.toLowerCase(),
    ),
  );

const DependencyFields = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeDependencyFields = Schema.decodeUnknownOption(Schema.fromJsonString(DependencyFields));

export const dependencyNames = (packageJson: string | undefined) =>
  Option.match(decodeDependencyFields(packageJson ?? "{}"), {
    onNone: () => new Set<string>(),
    onSome: (fields) =>
      new Set(
        [
          fields.dependencies,
          fields.devDependencies,
          fields.optionalDependencies,
          fields.peerDependencies,
        ].flatMap((field) => Object.keys(field ?? {})),
      ),
  });

const difference = (after: Iterable<string>, before: ReadonlySet<string>) =>
  [...new Set(after)].filter((value) => !before.has(value)).sort();

const sourceHosts = (root: string, tree: string, skip: ReadonlyArray<string> = []) =>
  git(
    root,
    [
      "grep",
      "-h",
      "-o",
      "-I",
      "-E",
      "https?://[A-Za-z0-9.-]+",
      tree,
      "--",
      ...SOURCE_PATHSPECS,
      ...skip.map((path) => `:(exclude,literal)${path}`),
    ],
    [0, 1],
  ).pipe(Effect.map(({ stdout }) => hostsIn(stdout)));

const markerFiles = (root: string, tree: string) =>
  gitLines(root, ["grep", "-c", "-I", "-F", MARKER, tree], [0, 1]).pipe(
    Effect.map((lines) =>
      lines.map((line) => {
        const [path = "", count = "0"] = line.slice(tree.length + 1).split(/:(?=\d+$)/);
        return { path, count: Number(count) };
      }),
    ),
  );

const forkOwnedPaths = Effect.fn("forkSync.forkOwnedPaths")(function* (
  root: string,
  paths: ReadonlyArray<string>,
) {
  if (paths.length === 0) return new Set<string>();
  const lines = yield* gitLines(root, ["check-attr", "merge", "--", ...paths]);
  return new Set(
    lines.flatMap((line) => {
      const separator = line.lastIndexOf(": merge: ");
      return separator !== -1 && line.slice(separator + 9) === "fork-ours"
        ? [line.slice(0, separator)]
        : [];
    }),
  );
});

const readBlob = (root: string, tree: string, path: string) =>
  git(root, ["show", `${tree}:${path}`], [0, 128]).pipe(
    Effect.map(({ stdout, exitCode }) => (exitCode === 0 ? stdout : undefined)),
  );

export interface UpstreamAudit {
  readonly target: string;
  readonly alreadyMerged: boolean;
  readonly commits: number;
  readonly changedFiles: number;
  readonly conflicts: ReadonlyArray<string>;
  readonly keptForkSide: ReadonlyArray<string>;
  readonly forkOwnedChangedUpstream: ReadonlyArray<string>;
  readonly markedFilesChangedUpstream: ReadonlyArray<string>;
  readonly markersBefore: number;
  readonly markersAfter: number;
  readonly newHosts: ReadonlyArray<string>;
  readonly newDependencies: ReadonlyArray<string>;
  readonly settingsDefaultLines: ReadonlyArray<string>;
  readonly patchesChanged: ReadonlyArray<string>;
  readonly telemetryPathsChanged: ReadonlyArray<string>;
}

/** Everything a reviewer needs before merging `target`, computed without touching the checkout. */
export const auditUpstream = Effect.fn("forkSync.auditUpstream")(function* (
  root: string,
  target: string,
) {
  const alreadyMerged =
    (yield* git(root, ["merge-base", "--is-ancestor", target, "HEAD"], [0, 1])).exitCode === 0;
  const base = (yield* git(root, ["merge-base", "HEAD", target])).stdout.trim();
  const merged = parseMergeTree(
    (yield* git(
      root,
      [...FORK_OURS, "merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", target],
      [0, 1],
    )).stdout,
  );
  const changed = yield* gitLines(root, ["diff", "--name-only", "--no-renames", base, target]);
  const owned = yield* forkOwnedPaths(root, [...new Set([...changed, ...merged.conflicts])]);

  const [markersBefore, markersAfter] = yield* Effect.all([
    markerFiles(root, "HEAD"),
    markerFiles(root, merged.tree),
  ]);
  const changedSet = new Set(changed);
  const keptForkSide = merged.conflicts.filter((path) => owned.has(path));
  // A modify/delete conflict leaves upstream's file in the written tree; the merge removes it.
  const [hostsBefore, hostsAfter] = yield* Effect.all([
    sourceHosts(root, "HEAD"),
    sourceHosts(root, merged.tree, keptForkSide),
  ]);

  const packageJsons = yield* gitLines(root, [
    "diff",
    "--name-only",
    "HEAD",
    merged.tree,
    "--",
    ":(glob)**/package.json",
    "package.json",
  ]);
  const newDependencies = yield* Effect.forEach(packageJsons, (path) =>
    Effect.all([readBlob(root, "HEAD", path), readBlob(root, merged.tree, path)]).pipe(
      Effect.map(([before, after]) =>
        difference(dependencyNames(after), dependencyNames(before)).map(
          (name) => `${name} (${path})`,
        ),
      ),
    ),
  );
  const settingsDiff = yield* gitLines(root, [
    "diff",
    "-U0",
    base,
    target,
    "--",
    "packages/contracts/src/settings.ts",
  ]);

  return {
    target,
    alreadyMerged,
    commits: Number((yield* git(root, ["rev-list", "--count", `${base}..${target}`])).stdout),
    changedFiles: changed.length,
    conflicts: merged.conflicts.filter((path) => !owned.has(path)),
    keptForkSide,
    forkOwnedChangedUpstream: changed.filter((path) => owned.has(path)),
    markedFilesChangedUpstream: markersBefore
      .map(({ path }) => path)
      .filter((path) => changedSet.has(path) && !owned.has(path)),
    markersBefore: markersBefore.reduce((sum, file) => sum + file.count, 0),
    markersAfter: markersAfter.reduce((sum, file) => sum + file.count, 0),
    newHosts: difference(hostsAfter, hostsBefore),
    newDependencies: newDependencies.flat(),
    settingsDefaultLines: settingsDiff.filter(
      (line) => /^[+-](?![+-])/.test(line) && /default/i.test(line),
    ),
    patchesChanged: changed.filter((path) => path.startsWith("patches/")),
    telemetryPathsChanged: changed.filter(
      (path) => TELEMETRY_PATH.test(path) && !TEST_PATH.test(path),
    ),
  } satisfies UpstreamAudit;
});

const section = (title: string, items: ReadonlyArray<string>, empty = "none") => [
  `## ${title}`,
  "",
  ...(items.length > 0 ? items.map((item) => `- ${item}`) : [empty]),
  "",
];

export const renderAudit = (audit: UpstreamAudit) => {
  if (audit.alreadyMerged) return `This branch already includes ${audit.target}.\n`;
  const markerNote =
    audit.markersAfter < audit.markersBefore
      ? `**${String(audit.markersBefore - audit.markersAfter)} \`${MARKER}\` markers would disappear.** A fork change was lost; find it before merging.`
      : `\`${MARKER}\` markers: ${String(audit.markersBefore)} before, ${String(audit.markersAfter)} after.`;
  return [
    `# Upstream ${audit.target}`,
    "",
    `${String(audit.commits)} commits, ${String(audit.changedFiles)} files changed upstream.`,
    markerNote,
    "",
    ...section("Conflicts to resolve by hand", audit.conflicts),
    ...section(
      "Fork-owned files upstream changed (the fork's side is kept; port interface changes)",
      audit.forkOwnedChangedUpstream,
    ),
    ...section(
      "Files with fork changes that upstream also changed (re-check the marked lines)",
      audit.markedFilesChangedUpstream,
    ),
    ...section("New hosts in shipped source", audit.newHosts),
    ...section("New dependencies", audit.newDependencies),
    ...section("Settings default changes", audit.settingsDefaultLines),
    ...section("Changed dependency patches", audit.patchesChanged),
    ...section("Changed telemetry and observability code", audit.telemetryPathsChanged),
    "What dependencies send at runtime is not visible here; see docs/fork/HARDENING.md.",
    "",
  ].join("\n");
};

/** Merges `target` on `sync/<name>` in a worktree beside `root`, keeping fork-owned files. */
export const mergeUpstream = Effect.fn("forkSync.mergeUpstream")(function* (
  root: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const name = target.replace(/[^A-Za-z0-9._-]+/g, "-");
  const branch = `sync/${name}`;
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-sync-${name}`);
  if (yield* fs.exists(worktree)) {
    return yield* new ForkSyncError({ message: `${worktree} already exists; remove it first.` });
  }
  yield* git(root, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  yield* git(
    worktree,
    [...FORK_OURS, "merge", "--no-ff", "--no-edit", "--no-verify", target],
    [0, 1],
  );
  const unmerged = yield* gitLines(worktree, ["diff", "--name-only", "--diff-filter=U"]);
  const owned = yield* forkOwnedPaths(worktree, unmerged);
  for (const file of owned) {
    const forkHasFile =
      (yield* git(worktree, ["cat-file", "-e", `HEAD:${file}`], [0, 128])).exitCode === 0;
    yield* forkHasFile
      ? git(worktree, ["checkout", "--ours", "--", file]).pipe(
          Effect.andThen(git(worktree, ["add", "--", file])),
        )
      : git(worktree, ["rm", "-q", "--", file]);
  }
  const conflicts = unmerged.filter((file) => !owned.has(file));
  const mergeInProgress =
    (yield* git(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], [0, 1])).exitCode === 0;
  if (conflicts.length === 0 && mergeInProgress) {
    yield* git(worktree, ["commit", "--no-edit", "--no-verify"]);
  }
  return { worktree, branch, conflicts, keptForkSide: [...owned] };
});

const resolveTarget = Effect.fn("forkSync.resolveTarget")(function* (
  root: string,
  ref: Option.Option<string>,
) {
  yield* git(root, ["fetch", "--quiet", "--tags", "upstream"]);
  if (Option.isSome(ref)) return ref.value;
  const tag = newestStableTag(yield* gitLines(root, ["tag", "--list", "v*"]));
  if (tag === undefined) {
    return yield* new ForkSyncError({ message: "upstream has no vX.Y.Z release tag." });
  }
  return tag;
});

export const forkSyncCommand = Command.make(
  "fork-sync",
  {
    ref: Argument.String("ref").pipe(
      Argument.withDescription("Upstream ref to check. Defaults to the newest vX.Y.Z release."),
      Argument.optional,
    ),
    merge: Flag.Boolean("merge").pipe(
      Flag.withDescription("Also merge it on sync/<ref> in a worktree next to this checkout."),
    ),
  },
  ({ ref, merge }) =>
    Effect.gen(function* () {
      const root = (yield* git(".", ["rev-parse", "--show-toplevel"])).stdout.trim();
      const target = yield* resolveTarget(root, ref);
      const audit = yield* auditUpstream(root, target);
      yield* Console.log(renderAudit(audit));
      if (!merge || audit.alreadyMerged) return;
      const result = yield* mergeUpstream(root, target);
      yield* Console.log(
        [
          `Merged ${target} on ${result.branch} in ${result.worktree}.`,
          ...(result.keptForkSide.length > 0
            ? [`Kept the fork's side of: ${result.keptForkSide.join(", ")}`]
            : []),
          ...(result.conflicts.length > 0
            ? [`Resolve these, then commit: ${result.conflicts.join(", ")}`]
            : ["The merge is committed. Verify it as docs/fork/HARDENING.md describes."]),
        ].join("\n"),
      );
    }).pipe(
      Effect.catchTags({
        ForkSyncError: (error) =>
          Console.error(error.message).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = 1;
              }),
            ),
          ),
      }),
    ),
).pipe(Command.withDescription("Audit an upstream release for this fork and optionally merge it."));

if (import.meta.main) {
  Command.run(forkSyncCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
