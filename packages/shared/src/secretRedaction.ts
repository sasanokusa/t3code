// Hardened fork: masks credential-shaped text before it is written to logs or trace files, so a
// token that ends up in an error message, request URL or span attribute is not kept in plaintext.
// `T3CODE_LOG_REDACT_SECRETS=off` turns it off for debugging.

const REDACTED_SECRET = "<redacted>";

// Provider and platform key prefixes: OpenAI/Anthropic `sk-`, Stripe, GitHub, GitLab, Slack, npm,
// Hugging Face, Google, AWS access key ids, xAI, Groq, Perplexity, 1Password service accounts.
const TOKEN_PREFIX =
  /\b(?:sk-|sk_live_|sk_test_|rk_live_|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|xapp-|npm_|hf_|AIza|AKIA|ASIA|xai-|gsk_|pplx-|ops_)[A-Za-z0-9_-]{8,4096}/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{4,8192}\.[A-Za-z0-9_-]{4,8192}\.[A-Za-z0-9_-]{1,8192}/gu;
const BEARER = /\b(Bearer|Basic|DPoP)[ \t]{1,8}[A-Za-z0-9._~+/=-]{8,8192}/gu;
// Every repetition is bounded and starts only where an identifier starts, so the cost stays linear
// on long unbroken runs (log lines can hold megabytes of base64 or minified output).
const URL_USERINFO =
  /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/giu;
// `"apiKey": "…"`, `token=…`, `CLIENT_SECRET: …`: the value after a credential-named key. Values
// without a letter (token counts such as `"maxTokens": 4096`) are left alone.
const KEYED_VALUE =
  /((?<![A-Za-z0-9_-])["']?[A-Za-z0-9_-]{0,48}?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|token|secret|credential)s?["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)((?=[^\s"'&,;}]{0,4096}[A-Za-z])[^\s"'&,;}]{6,4096})/giu;

export const redactSecrets = (text: string): string =>
  text
    .replace(URL_USERINFO, `$1${REDACTED_SECRET}@`)
    .replace(KEYED_VALUE, `$1${REDACTED_SECRET}`)
    .replace(BEARER, `$1 ${REDACTED_SECRET}`)
    .replace(JWT, REDACTED_SECRET)
    .replace(TOKEN_PREFIX, REDACTED_SECRET);

export const secretRedactionEnabled = (
  env: Readonly<Record<string, string | undefined>> | undefined,
): boolean => env?.T3CODE_LOG_REDACT_SECRETS !== "off";
