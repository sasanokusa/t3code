import { describe, expect, it } from "@effect/vitest";

import { redactSecrets, secretRedactionEnabled } from "./secretRedaction.ts";

describe("redactSecrets", () => {
  it("masks provider keys, JWTs and bearer tokens", () => {
    expect(redactSecrets("key sk-ant-api03-AbCdEf123456 used")).toBe("key <redacted> used");
    expect(redactSecrets("ghp_ABCDEFGHIJKLMNOP1234 failed")).toBe("<redacted> failed");
    expect(redactSecrets("Authorization: Bearer abc.def-ghi_123456")).toBe(
      "Authorization: Bearer <redacted>",
    );
    expect(redactSecrets("jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl end")).toBe("jwt <redacted> end");
  });

  it("masks values of credential-named keys but keeps counts", () => {
    expect(redactSecrets('{"apiKey":"abcdef123456","maxTokens":4096}')).toBe(
      '{"apiKey":"<redacted>","maxTokens":4096}',
    );
    expect(redactSecrets("https://x.test/cb?refresh_token=r3fr35hT0k3n&state=ok")).toBe(
      "https://x.test/cb?refresh_token=<redacted>&state=ok",
    );
    expect(redactSecrets("OPENAI_API_KEY=abc123xyz789")).toBe("OPENAI_API_KEY=<redacted>");
  });

  it("masks passwords in URLs", () => {
    expect(redactSecrets("git clone https://me:hunter2pass@git.example.com/r.git")).toBe(
      "git clone https://<redacted>@git.example.com/r.git",
    );
  });

  it("leaves ordinary text alone", () => {
    const text = "Running task-runner on desk-lamp with 1234 tokens in /tmp/project";
    expect(redactSecrets(text)).toBe(text);
  });

  it("can be turned off", () => {
    expect(secretRedactionEnabled({})).toBe(true);
    expect(secretRedactionEnabled({ T3CODE_LOG_REDACT_SECRETS: "off" })).toBe(false);
  });
});

describe("redactSecrets on long input", () => {
  // Runs on every log line and trace record; a backtracking regex once took 80 s on 200 kB, so a
  // regression shows up as this test timing out.
  it.each([
    "a".repeat(200_000),
    "a-".repeat(100_000),
    "token=".repeat(33_000),
    "ab+".repeat(70_000),
  ])("stays linear on long unbroken input", (input) => {
    expect(redactSecrets(input).length).toBeGreaterThan(0);
  });
});
