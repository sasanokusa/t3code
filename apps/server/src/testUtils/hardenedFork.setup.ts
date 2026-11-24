// Tests must never create items in the developer's real keychain; seal with a throwaway key file.
process.env.T3CODE_SECRETS_KEYCHAIN = "off";
// Upstream's T3 Connect tests configure their relay through Effect config, not process.env.
process.env.T3CODE_CONNECT_WITHOUT_RELAY_CHECK = "1";
