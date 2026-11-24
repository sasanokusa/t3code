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

**Limits.** A keychain item can still be read by another process of the same user that asks the OS
for it. macOS may prompt, depending on the item's access list. Encryption keeps secrets out of greps,
backups and accidental reads; it does not isolate them from a determined local process.

Secret-request files (`secrets/files/`), which hand a secret to an agent as a file, stay plaintext
by design and expire as before.

### Network egress

- **Egress guard.** Hosts under the following domains are refused for every `fetch` and `WebSocket`
  in the server, the desktop main process and the web client:
  - `t3.codes`, `t3.chat`, `t3.gg`, `ping.gg`
  - `posthog.com`, `axiom.co`, `sentry.io`

  The desktop also blocks them at the main window's Electron session. To let a host through on
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

Until then, use remote access without a relay: run the server on saserver and connect over
Tailscale.

## Pulling upstream

```bash
git fetch upstream
git merge upstream/main
git grep -n "Hardened fork"   # every fork change is marked; re-check them after the merge
```

After the merge, look at new code under `apps/server/src/telemetry`, new `fetch` targets and new
settings defaults.
