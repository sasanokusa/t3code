// Hardened fork: hosts this build never talks to, whatever settings, stored state or an upstream
// change says. T3's own services (accounts, relay, managed tunnels, ingest, hosted web app) and
// third-party telemetry are refused. A self-hosted relay on another host is unaffected.

/** Matched against the hostname and every parent domain of it. */
export const BLOCKED_HOST_SUFFIXES: ReadonlyArray<string> = [
  "t3.codes",
  "t3.chat",
  "t3.gg",
  "ping.gg",
  "posthog.com",
  "axiom.co",
  "sentry.io",
];

/**
 * Hosts listed in `T3CODE_EGRESS_ALLOW` (comma separated) are let through, for a user who
 * deliberately wants one of them back.
 */
export const parseEgressAllowList = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host !== ""),
  );

const hostnameOf = (target: string | URL): string | undefined => {
  try {
    return (typeof target === "string" ? new URL(target) : target).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/** The blocked suffix `target` falls under, or undefined when it may be reached. */
export const blockedEgressSuffix = (
  target: string | URL,
  allow: ReadonlySet<string> = new Set(),
): string | undefined => {
  const hostname = hostnameOf(target)?.replace(/\.$/u, "");
  if (hostname === undefined || allow.has(hostname)) return undefined;
  return BLOCKED_HOST_SUFFIXES.find(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
};

export class EgressBlockedError extends TypeError {
  readonly url: string;
  constructor(url: string) {
    super(`Blocked by this build's egress policy: ${url}`);
    this.url = url;
  }
}

const requestUrl = (input: unknown): string | undefined => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof input === "object" && input !== null && "url" in input) {
    const url = (input as { url: unknown }).url;
    return typeof url === "string" ? url : undefined;
  }
  return undefined;
};

/** Wraps `fetch` so requests to blocked hosts fail before any connection is opened. */
export const guardFetch = <F extends (input: never, init?: never) => Promise<unknown>>(
  fetchImpl: F,
  allow: ReadonlySet<string> = new Set(),
): F => {
  const guarded = (input: Parameters<F>[0], init?: Parameters<F>[1]) => {
    const url = requestUrl(input);
    if (url !== undefined && blockedEgressSuffix(url, allow) !== undefined) {
      return Promise.reject(new EgressBlockedError(url));
    }
    return fetchImpl(input, init);
  };
  return guarded as F;
};

type AnyConstructor = new (...args: any[]) => object;

/** Wraps a WebSocket constructor so sockets to blocked hosts are refused. */
export const guardWebSocket = <C extends AnyConstructor>(
  WebSocketImpl: C,
  allow: ReadonlySet<string> = new Set(),
): C =>
  class extends WebSocketImpl {
    constructor(...args: any[]) {
      const url = args[0] as string | URL;
      if (blockedEgressSuffix(url, allow) !== undefined) {
        throw new EgressBlockedError(String(url));
      }
      super(...args);
    }
  };
