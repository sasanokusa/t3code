// @effect-diagnostics nodeBuiltinImport:off - OS keychain helpers need stdin pipes and AES-GCM.
//
// Hardened fork: upstream wrote every server secret (session signing keys, provider tokens, API
// keys, T3 Connect credentials) to `secrets/<name>.bin` in plaintext, so any process of the same
// user, such as a coding agent CLI, could read them. Secrets are now sealed with AES-256-GCM under
// a master key held by the OS credential store:
//
// - macOS: a generic password in the login keychain (`security`).
// - Linux: the Secret Service (`secret-tool`, e.g. GNOME Keyring or KWallet).
// - Windows: DPAPI for the current user, with the protected blob beside the secrets.
// - `T3CODE_SECRETS_KEY` (64 hex chars) overrides all of these, e.g. for a headless server.
// - Without any of them the key falls back to `secrets/master.key` (0600), with a warning. That
//   still keeps secrets out of greps and backups, but not from a process that reads that file.
//
// A keychain item is readable by other processes of the same user that ask the OS for it (macOS
// may prompt, depending on the item's access list), so this raises the bar rather than isolating
// secrets completely. `secrets/encryption.json` records where the key lives, so a later start that
// cannot reach that store fails loudly instead of minting a new key and orphaning every secret.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

const MAGIC = Buffer.from("T3E1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEYCHAIN_SERVICE = "T3 Code secrets key";
const COMMAND_TIMEOUT_MS = 60_000;

export type MasterKeySource =
  | "env"
  | "macos-keychain"
  | "secret-service"
  | "windows-dpapi"
  | "key-file";

export interface MasterKey {
  readonly key: Buffer;
  readonly source: MasterKeySource;
  /** Set when the key could not be kept in an OS credential store. */
  readonly warning?: string;
}

export class SecretsEncryptionError extends Schema.TaggedError<SecretsEncryptionError>()(
  "SecretsEncryptionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string): never => {
  throw new SecretsEncryptionError({ detail });
};

export const isEncrypted = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= MAGIC.length + IV_BYTES + TAG_BYTES &&
  Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC);

/** Seals `plaintext` for the secret called `name`; the name is bound in as associated data. */
export const seal = (key: Buffer, name: string, plaintext: Uint8Array): Uint8Array => {
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
};

/** Opens a sealed secret. Throws when the key, the name or the bytes do not match. */
export const open = (key: Buffer, name: string, sealed: Uint8Array): Uint8Array => {
  const bytes = Buffer.from(sealed);
  const iv = bytes.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = bytes.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const body = bytes.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(tag);
  return Uint8Array.from(Buffer.concat([decipher.update(body), decipher.final()]));
};

interface CommandResult {
  readonly ok: boolean;
  readonly missing: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (command: string, args: ReadonlyArray<string>, input?: string): CommandResult => {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    input,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return {
    ok: result.error === undefined && result.status === 0,
    missing,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const decodeHexKey = (text: string): Buffer | undefined => {
  const trimmed = text.trim();
  return /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : undefined;
};

// One key per secrets directory, so a dev home never shares a key with the real install.
const keychainAccount = (secretsDir: string) =>
  NodeCrypto.createHash("sha256").update(NodePath.resolve(secretsDir)).digest("hex").slice(0, 32);

interface KeyStore {
  readonly source: MasterKeySource;
  /** `undefined` when the store works but holds no key; throws when the store cannot be used. */
  readonly read: () => Buffer | undefined;
  readonly write: (key: Buffer) => void;
  /** False when this store cannot be used on this machine at all. */
  readonly available: () => boolean;
}

const macosKeychain = (account: string): KeyStore => ({
  source: "macos-keychain",
  available: () => !run("security", ["help"]).missing,
  read: () => {
    const found = run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
    ]);
    // 44 is errSecItemNotFound.
    if (found.status === 44) return undefined;
    if (!found.ok) {
      return fail(
        `Could not read the secrets key from the macOS keychain (${found.stderr.trim() || `exit ${found.status}`}).`,
      );
    }
    const key = decodeHexKey(found.stdout);
    if (key === undefined) {
      return fail("The secrets key in the macOS keychain is malformed.");
    }
    return key;
  },
  // `security -i` reads the command from stdin, so the key never appears in a process listing.
  write: (key) => {
    const added = run(
      "security",
      ["-i"],
      `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -l "${KEYCHAIN_SERVICE}" -w "${key.toString("hex")}"\n`,
    );
    if (!added.ok || /error/i.test(added.stderr)) {
      return fail(
        `Could not save the secrets key to the macOS keychain (${added.stderr.trim() || `exit ${added.status}`}).`,
      );
    }
  },
});

const secretService = (account: string): KeyStore => {
  const attributes = ["service", KEYCHAIN_SERVICE, "account", account];
  return {
    source: "secret-service",
    available: () => {
      const probe = run("secret-tool", ["lookup", ...attributes]);
      // Not found exits 1 quietly; a missing D-Bus session or keyring daemon prints an error.
      return !probe.missing && (probe.ok || probe.stderr.trim() === "");
    },
    read: () => {
      const found = run("secret-tool", ["lookup", ...attributes]);
      if (!found.ok && found.stderr.trim() === "") return undefined;
      if (!found.ok) {
        return fail(
          `Could not read the secrets key from the Secret Service (${found.stderr.trim()}).`,
        );
      }
      const key = decodeHexKey(found.stdout);
      if (key === undefined) {
        return fail("The secrets key in the Secret Service is malformed.");
      }
      return key;
    },
    write: (key) => {
      const stored = run(
        "secret-tool",
        ["store", "--label", KEYCHAIN_SERVICE, ...attributes],
        key.toString("hex"),
      );
      if (!stored.ok) {
        return fail(
          `Could not save the secrets key to the Secret Service (${stored.stderr.trim() || `exit ${stored.status}`}).`,
        );
      }
    },
  };
};

const POWERSHELL_DPAPI = (operation: "Protect" | "Unprotect") =>
  "Add-Type -AssemblyName System.Security; " +
  "$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
  `$out = [Security.Cryptography.ProtectedData]::${operation}($in, $null, 'CurrentUser'); ` +
  "[Console]::Out.Write([Convert]::ToBase64String($out))";

const windowsDpapi = (secretsDir: string): KeyStore => {
  const blobPath = NodePath.join(secretsDir, "master-key.dpapi");
  const powershell = (operation: "Protect" | "Unprotect", input: string) =>
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_DPAPI(operation)],
      input,
    );
  return {
    source: "windows-dpapi",
    available: () => !run("powershell.exe", ["-NoProfile", "-Command", "exit 0"]).missing,
    read: () => {
      if (!NodeFS.existsSync(blobPath)) return undefined;
      const opened = powershell("Unprotect", NodeFS.readFileSync(blobPath, "utf8"));
      const key = opened.ok ? Buffer.from(opened.stdout.trim(), "base64") : undefined;
      if (key === undefined || key.byteLength !== KEY_BYTES) {
        return fail(
          `Could not unprotect the secrets key with DPAPI (${opened.stderr.trim() || `exit ${opened.status}`}).`,
        );
      }
      return key;
    },
    write: (key) => {
      const sealed = powershell("Protect", key.toString("base64"));
      if (!sealed.ok || sealed.stdout.trim() === "") {
        return fail(
          `Could not protect the secrets key with DPAPI (${sealed.stderr.trim() || `exit ${sealed.status}`}).`,
        );
      }
      NodeFS.writeFileSync(blobPath, sealed.stdout.trim(), { mode: 0o600 });
    },
  };
};

const keyFile = (secretsDir: string): KeyStore => {
  const filePath = NodePath.join(secretsDir, "master.key");
  return {
    source: "key-file",
    available: () => true,
    read: () => {
      if (!NodeFS.existsSync(filePath)) return undefined;
      const key = decodeHexKey(NodeFS.readFileSync(filePath, "utf8"));
      if (key === undefined) {
        return fail(`The secrets key at ${filePath} is malformed.`);
      }
      return key;
    },
    write: (key) => {
      NodeFS.writeFileSync(filePath, key.toString("hex"), { mode: 0o600, flag: "wx" });
      NodeFS.chmodSync(filePath, 0o600);
    },
  };
};

interface EncryptionMarker {
  readonly version: 1;
  readonly keySource: MasterKeySource;
}

const markerPath = (secretsDir: string) => NodePath.join(secretsDir, "encryption.json");

const readMarker = (secretsDir: string): EncryptionMarker | undefined => {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(markerPath(secretsDir), "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 1 &&
      typeof (parsed as { keySource?: unknown }).keySource === "string"
    ) {
      return parsed as EncryptionMarker;
    }
  } catch {}
  return undefined;
};

const writeMarker = (secretsDir: string, keySource: MasterKeySource) =>
  NodeFS.writeFileSync(
    markerPath(secretsDir),
    `${JSON.stringify({ version: 1, keySource } satisfies EncryptionMarker)}\n`,
    { mode: 0o600 },
  );

const hasSealedSecrets = (secretsDir: string): boolean => {
  try {
    return NodeFS.readdirSync(secretsDir).some((name) => {
      if (!name.endsWith(".bin")) return false;
      const fd = NodeFS.openSync(NodePath.join(secretsDir, name), "r");
      try {
        const head = Buffer.alloc(MAGIC.length);
        return NodeFS.readSync(fd, head, 0, MAGIC.length, 0) === MAGIC.length && head.equals(MAGIC);
      } finally {
        NodeFS.closeSync(fd);
      }
    });
  } catch {
    return false;
  }
};

export interface LoadMasterKeyOptions {
  readonly secretsDir: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const osStoreFor = (options: LoadMasterKeyOptions): KeyStore | undefined => {
  const account = keychainAccount(options.secretsDir);
  switch (options.platform) {
    case "darwin":
      return macosKeychain(account);
    case "win32":
      return windowsDpapi(options.secretsDir);
    case "linux":
    case "freebsd":
    case "openbsd":
      return secretService(account);
    default:
      return undefined;
  }
};

/**
 * Finds the master key for `secretsDir`, creating one in the best available store the first time.
 * Never replaces a key that sealed secrets depend on.
 */
export const loadMasterKey = (options: LoadMasterKeyOptions): MasterKey => {
  const fromEnv = options.env.T3CODE_SECRETS_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const key = decodeHexKey(fromEnv);
    if (key === undefined) {
      return fail("T3CODE_SECRETS_KEY must be 64 hexadecimal characters.");
    }
    return { key, source: "env" };
  }

  const keychainDisabled = options.env.T3CODE_SECRETS_KEYCHAIN === "off";
  const osStore = keychainDisabled ? undefined : osStoreFor(options);
  const fileStore = keyFile(options.secretsDir);
  const marker = readMarker(options.secretsDir);

  if (marker !== undefined) {
    if (marker.keySource === "env") {
      return fail("These secrets were sealed with T3CODE_SECRETS_KEY; set it again to start.");
    }
    const store =
      marker.keySource === "key-file"
        ? fileStore
        : osStore?.source === marker.keySource
          ? osStore
          : undefined;
    if (store === undefined) {
      return fail(
        `These secrets were sealed with a key kept in ${marker.keySource}, which is not usable here.`,
      );
    }
    const key = store.read();
    if (key !== undefined) return withWarning({ key, source: store.source });
    if (hasSealedSecrets(options.secretsDir)) {
      return fail(
        `The secrets key is missing from ${marker.keySource}; sealed secrets cannot be opened.`,
      );
    }
    return withWarning(createIn(store, options.secretsDir));
  }

  if (hasSealedSecrets(options.secretsDir)) {
    // Sealed secrets without a marker: try every store before giving up.
    for (const store of [osStore, fileStore]) {
      if (store === undefined || !store.available()) continue;
      const key = store.read();
      if (key !== undefined) {
        writeMarker(options.secretsDir, store.source);
        return withWarning({ key, source: store.source });
      }
    }
    return fail("Sealed secrets exist but no key for them was found.");
  }

  const store = osStore !== undefined && osStore.available() ? osStore : fileStore;
  const existing = store.read();
  if (existing !== undefined) {
    writeMarker(options.secretsDir, store.source);
    return withWarning({ key: existing, source: store.source });
  }
  return withWarning(createIn(store, options.secretsDir));
};

const createIn = (store: KeyStore, secretsDir: string): MasterKey => {
  const key = NodeCrypto.randomBytes(KEY_BYTES);
  store.write(key);
  // Read it back so a store that accepted the write but cannot return it never seals anything.
  const stored = store.read();
  if (stored === undefined || !stored.equals(key)) {
    return fail(`The secrets key could not be read back from ${store.source}.`);
  }
  writeMarker(secretsDir, store.source);
  return { key, source: store.source };
};

const withWarning = (masterKey: MasterKey): MasterKey =>
  masterKey.source === "key-file"
    ? {
        ...masterKey,
        warning:
          "No OS credential store is available, so the secrets key is kept in secrets/master.key. " +
          "Set T3CODE_SECRETS_KEY or install a Secret Service to keep it apart from the secrets.",
      }
    : masterKey;
