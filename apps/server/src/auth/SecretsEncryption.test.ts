// @effect-diagnostics nodeBuiltinImport:off - exercises the sync key loader on real temp dirs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import * as SecretsEncryption from "./SecretsEncryption.ts";

const tempSecretsDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-secrets-enc-"));
const KEY_HEX = "11".repeat(32);

describe("SecretsEncryption", () => {
  it("round-trips a value and binds it to its name", () => {
    const key = Buffer.from(KEY_HEX, "hex");
    const sealed = SecretsEncryption.seal(key, "token", new TextEncoder().encode("sk-live"));

    assert.isTrue(SecretsEncryption.isEncrypted(sealed));
    assert.notInclude(Buffer.from(sealed).toString("latin1"), "sk-live");
    assert.equal(new TextDecoder().decode(SecretsEncryption.open(key, "token", sealed)), "sk-live");
    assert.throws(() => SecretsEncryption.open(key, "other-name", sealed));
    assert.throws(() => SecretsEncryption.open(Buffer.alloc(32, 2), "token", sealed));
  });

  it("does not mistake plaintext for a sealed value", () => {
    assert.isFalse(SecretsEncryption.isEncrypted(new TextEncoder().encode("sk-live-plaintext")));
  });

  it("prefers T3CODE_SECRETS_KEY and rejects a malformed one", () => {
    const secretsDir = tempSecretsDir();
    const fromEnv = SecretsEncryption.loadMasterKey({
      secretsDir,
      platform: "linux",
      env: { T3CODE_SECRETS_KEY: KEY_HEX },
    });
    assert.equal(fromEnv.source, "env");
    assert.equal(fromEnv.key.toString("hex"), KEY_HEX);
    assert.throws(() =>
      SecretsEncryption.loadMasterKey({
        secretsDir,
        platform: "linux",
        env: { T3CODE_SECRETS_KEY: "short" },
      }),
    );
  });

  it("falls back to a private key file and reuses it", () => {
    const secretsDir = tempSecretsDir();
    const options = {
      secretsDir,
      platform: "linux" as const,
      env: { T3CODE_SECRETS_KEYCHAIN: "off" },
    };
    const first = SecretsEncryption.loadMasterKey(options);
    const second = SecretsEncryption.loadMasterKey(options);

    assert.equal(first.source, "key-file");
    assert.isDefined(first.warning);
    assert.isTrue(first.key.equals(second.key));
    if (NodePath.sep === "/") {
      assert.equal(NodeFS.statSync(NodePath.join(secretsDir, "master.key")).mode & 0o777, 0o600);
    }
  });

  it("refuses to mint a new key when the recorded store is unusable", () => {
    const secretsDir = tempSecretsDir();
    NodeFS.writeFileSync(
      NodePath.join(secretsDir, "encryption.json"),
      JSON.stringify({ version: 1, keySource: "macos-keychain" }),
    );
    assert.throws(
      () =>
        SecretsEncryption.loadMasterKey({
          secretsDir,
          platform: "linux",
          env: { T3CODE_SECRETS_KEYCHAIN: "off" },
        }),
      /macos-keychain/,
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(secretsDir, "master.key")));
  });

  it("refuses to mint a new key when sealed secrets have no key", () => {
    const secretsDir = tempSecretsDir();
    const sealed = SecretsEncryption.seal(Buffer.from(KEY_HEX, "hex"), "x", new Uint8Array([1]));
    NodeFS.writeFileSync(NodePath.join(secretsDir, "x.bin"), sealed);
    assert.throws(() =>
      SecretsEncryption.loadMasterKey({
        secretsDir,
        platform: "linux",
        env: { T3CODE_SECRETS_KEYCHAIN: "off" },
      }),
    );
  });
});
