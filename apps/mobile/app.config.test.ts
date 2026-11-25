import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    T3CODE_IOS_PERSONAL_TEAM: process.env.T3CODE_IOS_PERSONAL_TEAM,
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: process.env.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined, personalTeamBundleId?: string) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM", personalTeamBundleId === undefined ? undefined : "1");
  vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID", personalTeamBundleId);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
});

it("leaves a Personal Team build's signing team to the developer", async () => {
  const config = await loadConfig("production", "com.example.t3code");
  expect(config.ios?.bundleIdentifier).toBe("com.example.t3code");
  expect(config.ios?.appleTeamId).toBeUndefined();
});

it("pins the team for full-capability builds", async () => {
  const config = await loadConfig("production");
  expect(config.ios?.appleTeamId).toBe("ARK85ZXQ4Z");
});

// Hardened fork: nothing in the config points the app or the OS at T3's or Axiom's servers.
it.each([undefined, "development", "preview", "production"])(
  "keeps T3 hosts, OTA updates and telemetry defaults out of APP_VARIANT=%j",
  async (value) => {
    const config = await loadConfig(value);
    expect(config.updates?.enabled).toBe(false);
    expect(config.updates?.url).toBeUndefined();
    expect(config.updates?.checkAutomatically).toBe("NEVER");
    expect(config.owner).toBeUndefined();
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
    expect(config.extra?.observability?.tracesUrl).toBeNull();
    expect(config.extra?.eas?.observe?.endpointUrl).toBe("https://observe.invalid");
    expect(JSON.stringify(config)).not.toMatch(/t3\.codes|axiom|u\.expo\.dev|pingdotgg|d763fcb8/);
  },
);
