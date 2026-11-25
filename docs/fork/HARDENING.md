# Hardened fork

A private fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It sends nothing to T3's
services or to third-party telemetry by default. It also stores secrets encrypted and keeps them out
of logs. Each change is marked in the code with a `Hardened fork:` comment, so
`git grep "Hardened fork"` lists them. The diff is kept small so the fork can keep merging upstream.

## What changed

### Telemetry

| Upstream behavior                                                                                                                                               | Fork                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `AnalyticsService` batched events to `ingest.t3.codes` (then PostHog) every 10 s, on by default                                                                 | No-op: nothing is buffered or sent (`apps/server/src/telemetry/AnalyticsService.ts`)                      |
| `Identify.ts` read `~/.codex/auth.json` and `~/.claude.json` and sent unsalted SHA-256 hashes of the OpenAI user id, Claude account UUID and T3 Connect account | Removed: no other tool's files are read and no ids are reported (`apps/server/src/telemetry/Identify.ts`) |
| Clients sent hashed Connect account and device ids on every WebSocket connect                                                                                   | Never sent (`packages/client-runtime/src/authorization/remote.ts`)                                        |
| Relay tracing to Axiom (server, web, desktop)                                                                                                                   | Off (`resolveRelayClientTracingConfig` and `resolveRelayTracingConfig` return `null`)                     |

Provider SDKs and CLIs that the server runs also get `DISABLE_TELEMETRY=1`,
`DISABLE_ERROR_REPORTING=1` and `DO_NOT_TRACK=1`, unless you set them yourself. The Claude Agent
SDK otherwise sends events to Datadog (`apps/server/src/outboundHttp.ts`).

### Secrets

- **Encrypted at rest.** Server secrets in `~/.t3/userdata/secrets/*.bin` were plaintext. They are
  now sealed with AES-256-GCM, with the secret's name as associated data. The master key lives in:
  - the macOS login keychain (item "T3 Code secrets key")
  - the Linux Secret Service (`secret-tool`)
  - Windows DPAPI
  - or `T3CODE_SECRETS_KEY` (64 hex characters), which overrides all of the above.

  With none of these available, the key falls back to `secrets/master.key` (0600) and a warning is
  logged. Plaintext files left by upstream builds are sealed on the next start.
  `secrets/encryption.json` records where the key lives. If that store is unavailable on a later
  start, the server refuses to start instead of minting a new key and orphaning the secrets.

  Code: `apps/server/src/auth/SecretsEncryption.ts`, `ServerSecretStore.ts`.

- **Resolved secrets expire.** Values read through secret providers (1Password and others) used to
  stay in memory for the server's life. They now expire after 10 minutes
  (`packages/secret-provider-core/src/server/SecretResolver.ts`).
- **No heap dumps on signal.** A `SIGUSR2` from any process of the same user wrote a full V8 heap
  snapshot, with every in-memory secret, to the logs directory. Snapshots are now off unless
  `T3CODE_HEAP_SNAPSHOT_ON_SIGUSR2=1`, and the file is written 0600.
- **Masking in logs and traces.** Before log messages, error causes and local trace files are
  written, the server masks:
  - API keys (`sk-…`, `ghp_…` and the like)
  - JWTs
  - `Bearer` / `Basic` / `DPoP` tokens
  - passwords in URLs
  - values of credential-named keys (`apiKey`, `token`, `password`, …)

  `T3CODE_LOG_REDACT_SECRETS=off` turns masking off for debugging
  (`packages/shared/src/secretRedaction.ts`).

**Limits.** On macOS the key is written with `/usr/bin/security`, so its access list trusts that
tool. Any process of the same user can read it without a prompt by running
`security find-generic-password -s "T3 Code secrets key" -w`. Encryption keeps secrets out of greps,
backups and casual file reads (an agent that `cat`s `~/.t3`). It does not stop a local process that
deliberately asks the keychain. Closing that gap would mean handing the key over from the desktop
app's own signed keychain item (Electron `safeStorage`), which this fork does not do yet.

The desktop app's Clerk session (`userdata/clerk/clerk-tokens.json`) is still a plaintext file.
This build never signs in to Clerk, so it only matters for a session an official build left behind.

Secret-request files (`secrets/files/`), which hand a secret to an agent as a file, stay plaintext
by design and expire as before.

### Network egress

- **Egress guard.** Hosts under the following domains are refused for every `fetch` and `WebSocket`
  in the server (which covers its Effect `HttpClient`), the web client and the desktop main
  process's global `fetch`:
  - `t3.codes`, `t3.chat`, `t3.gg`, `ping.gg`
  - `posthog.com`, `axiom.co`, `sentry.io`

  The desktop also blocks them at the main window's Electron session. The desktop main process's
  own undici `HttpClient` is not guarded; it only talks to the local backend, Tailscale and SSH
  hosts. To let a host through on
  purpose, list it in `T3CODE_EGRESS_ALLOW` (comma separated). Code:
  `packages/shared/src/egressPolicy.ts`, `apps/server/src/outboundHttp.ts`,
  `apps/desktop/src/window/EgressBlockPolicy.ts`.

- **T3 Connect** (relay, Clerk sign-in, managed Cloudflare tunnel, agent activity publishing) runs
  only when `T3CODE_RELAY_URL` names a relay that is not one of T3's hosts
  (`allowsConnect` in `apps/server/src/policy/managedLimits.ts`). Without one, T3 Connect stays
  off. On first start, the fork also unlinks a link an official build left in `~/.t3`, the same
  way a managed policy that turns Connect off does. Its tunnel stops, and clients paired through
  `app.t3.codes` lose access.
- **Pairing links** go straight to your server (`https://<host>/pair#token=…`). Hosted
  `app.t3.codes/pair?host=…` links named your server's host to T3; the fork builds hosted links
  only when `VITE_HOSTED_APP_URL` points at your own copy of the web app.
- **Favicons.** Upstream sent the host of every link in a conversation to Google's favicon service
  and loaded `<site>/favicon.ico` for tool rows. Only inline `data:` icons are shown now
  (`packages/shared/src/favicon.ts`).
- **Provider update checks** are off by default (`enableProviderUpdateChecks`). When on, they poll
  each provider CLI's release feed and T3's model manifest on GitHub every hour. You can turn them
  on in Settings.
- **Self-update.** None of these can install upstream's build any more; that would replace this
  fork with the official app, telemetry included:
  - the server's "Update track"
  - `t3 update`
  - the SSH-environment bootstrap
  - the npm launcher
  - `install.sh` / `install.ps1`

  The update track and `t3 update` refuse outright. The rest point at `sasanokusa/t3code`. Update
  by pulling and rebuilding from source.

- **Desktop updater.** A source build has no update feed (`app-update.yml` is not generated unless
  `T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY` is set), so it never fetches upstream's
  releases.
- **Mobile** (`apps/mobile`):
  - no OTA updates from T3's EAS project
  - no default Axiom endpoint, and crash reports off
  - no `app.t3.codes` / `clerk.t3.codes` associated domains or verified links
  - no GitHub release check
- **Removed files.** `.task-cache.json` pointed at T3's build cache, and `.env.example` no longer
  carries T3's Clerk key or relay URL.

## Self-hosting the relay on saserver

T3 Connect needs a relay. Upstream's (`infra/relay`) is a Cloudflare Worker using PlanetScale, Clerk,
Cloudflare Tunnels, APNs/FCM and Axiom, so it does not run on a plain Linux box as is. The fork is
ready for a self-hosted one:

1. Run a relay on saserver. Options:
   - [ttulttul/t3code-rust](https://github.com/ttulttul/t3code-rust): its `--relay` mode is a
     standalone relay with SQLite. It still expects Clerk-style JWTs (`CLERK_JWT_KEY`,
     `CLERK_ISSUER`), so you need your own Clerk instance or a small issuer of your own.
   - Porting `infra/relay` off Cloudflare.
2. Expose it over HTTPS. saserver already has `tailscale serve` (tailnet only) and `cloudflared`
   (public).
3. Build the fork with `T3CODE_RELAY_URL=https://<your relay>` in `.env`, plus your own Clerk keys
   if the relay uses Clerk.

Until then, reach the host over Tailscale instead. Run `t3 pair --tailscale` on the host, or turn
on **Tailscale HTTPS** in the desktop app's Settings → Sharing & access. The server stays on
loopback, and `tailscale serve` publishes it as `https://<machine>.<tailnet>.ts.net` to the tailnet
only. This also works on networks that block UDP or unusual ports, such as school or office
Wi-Fi: Tailscale then relays over HTTPS (port 443). T3 Connect's Cloudflare tunnel needs port 7844.

On a phone that already knows the host through T3 Connect, add the pairing link from that
environment's settings with **Add route**. Adding it as a new environment is refused, because the
host is already saved.

T3 Code runs `tailscale` from `PATH`. The Mac App Store build of Tailscale keeps its CLI inside the
app bundle, so put a wrapper on `PATH`:

```sh
#!/bin/sh
exec /Applications/Tailscale.app/Contents/MacOS/Tailscale "$@"
```

## Pulling upstream

`origin/main` mirrors upstream untouched; `hardening` is the fork. Track upstream's stable releases
(`vX.Y.Z`, every few days), not `main`, which takes hundreds of commits a day.

1. **Audit.** `node scripts/fork-sync.ts` fetches `upstream`, picks the newest release (or the ref you
   pass) and test-merges it without touching your checkout. It reports:
   - conflicts left to resolve by hand
   - fork-owned files upstream changed
   - files with fork changes that upstream also changed
   - whether any `Hardened fork` marker would disappear
   - new hosts in shipped source, new dependencies, settings default changes, changed dependency
     patches and changed telemetry code

   Read every section that is not "none".

2. **Merge.** `node scripts/fork-sync.ts --merge` merges the release on `sync/<tag>` in a worktree
   next to this checkout. Files marked `merge=fork-ours` in `.gitattributes` are the ones the fork
   replaced or removed outright, and they keep the fork's side. When upstream changed one, carry
   over interface changes into the fork's version as no-ops. Resolve any other conflicts and commit.
3. **Verify** in the worktree: `vp i`, `vp run -r typecheck`, then the fork's own tests, i.e. the
   test files that differ from the release (`git diff --name-only <tag> -- '*.test.ts*'`). Other
   failing tests are upstream's; compare with the release before chasing them.
4. **Land.** `git switch hardening && git merge --ff-only sync/<tag> && git push origin hardening`,
   then remove the worktree and the `sync/<tag>` branch.
5. **Install.** When no agent is working in T3 Code, build the desktop app
   (`node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64 --build-version
   <version>-hardened.<n>`), quit the running app, replace `/Applications/T3 Code (Beta).app`, and
   re-sign it ad hoc (`codesign --force --deep --sign -`). macOS asks again for keychain access.

The audit only reads source. What a dependency sends at runtime is not visible to it: the Claude
Agent SDK's Datadog reporting was found by running the built server with a fresh `T3CODE_HOME`,
`NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` pointing at a local proxy that logs and refuses every
request. Repeat that after a release that adds or upgrades dependencies.
