// Hardened fork: upstream read ~/.codex/auth.json and ~/.claude.json here, hashed the OpenAI
// user id, Claude account UUID and T3 Connect account with unsalted SHA-256, and reported them
// so installs could be linked to people. None of that remains. The types and `openAiUserId` stay
// because other modules still import them.
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// `user_id` (`user-…`) is the OpenAI account and is the same for every login.
const IdTokenClaims = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({ user_id: Schema.NonEmptyString }),
});
const decodeIdTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenClaims));

export const TelemetryOwnerSource = Schema.Literals(["connect", "openai", "claude", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  readonly ownerId: string;
}

/** The OpenAI account id in a ChatGPT id_token, read without verifying it. */
export const openAiUserId = (idToken: string) => {
  const payload = Base64Url.decodeString(idToken.split(".")[1] ?? "");
  return Result.isSuccess(payload)
    ? Option.map(
        decodeIdTokenClaims(payload.success),
        (claims) => claims["https://api.openai.com/auth"].user_id,
      )
    : Option.none<string>();
};

/** Reads nothing: this fork never collects owner ids. */
export const getServerOwners: Effect.Effect<ReadonlyArray<TelemetryOwner>> = Effect.succeed([]);
