import { BLOCKED_HOST_SUFFIXES } from "@t3tools/shared/egressPolicy";
import type * as Electron from "electron";

// Hardened fork: the renderer never reaches T3-owned or telemetry hosts, whatever loads in it.
const BLOCKED_URL_PATTERNS = BLOCKED_HOST_SUFFIXES.flatMap((suffix) => [
  `*://${suffix}/*`,
  `*://*.${suffix}/*`,
]);

export function installMainWindowEgressBlockPolicy(
  session: Pick<Electron.Session, "webRequest">,
): () => void {
  session.webRequest.onBeforeRequest({ urls: BLOCKED_URL_PATTERNS }, (_details, callback) => {
    callback({ cancel: true });
  });
  return () => {
    session.webRequest.onBeforeRequest(null);
  };
}
