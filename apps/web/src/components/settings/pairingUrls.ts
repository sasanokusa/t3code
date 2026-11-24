import { buildHostedPairingUrl, hasSelfHostedApp } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  // Hardened fork: a hosted pairing link names this server's host to the hosted app's origin, so
  // it is offered only for a self-hosted app (VITE_HOSTED_APP_URL); otherwise links go direct.
  if (url.protocol !== "https:" || !hasSelfHostedApp()) {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
