// Reads secrets that settings point at through a configured secret provider. Each read, including
// a failed one, is held for `cacheTtlMs` (10 minutes by default; upstream held it for the server's
// whole life), so rebuilds rarely re-prompt an unlock. `invalidate` and a `fresh` read read again.
import type { SecretReference, ServerSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { SecretProviderDriver, SecretProviderDriverServices } from "./driver.ts";

export class SecretResolver extends Context.Service<
  SecretResolver,
  {
    /**
     * Values in input order; `undefined` marks a reference that could not be read. `fresh` asks the
     * provider again and returns what it answered, but an unreadable or empty answer does not
     * replace a value that is already held.
     */
    readonly read: (
      references: ReadonlyArray<SecretReference>,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ReadonlyArray<string | undefined>>;
    /** Forgets the given references, or every reference, so the next read asks the provider again. */
    readonly invalidate: (references?: ReadonlyArray<SecretReference>) => Effect.Effect<void>;
    /** The name the user gave a secret provider, or its id when it has none or is gone. */
    readonly label: (provider: SecretReference["provider"]) => Effect.Effect<string>;
  }
>()("@t3tools/secret-provider-core/server/SecretResolver") {}

const cacheKey = (reference: SecretReference) =>
  `${reference.provider}\u0000${reference.reference}`;

interface CachedSecret {
  // A provider whose config changed, such as another account, reads again.
  readonly config: string;
  readonly value: string | undefined;
  readonly expiresAt: number;
}

/** How long a resolved secret stays in memory before the provider is asked again. */
export const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

const decodeConfigWith = Schema.decodeUnknownOption<Schema.Codec<unknown, unknown>>;

interface ReadablePlan {
  readonly driver: SecretProviderDriver;
  readonly config: unknown;
  readonly configKey: string;
}

export const make = Effect.fn("SecretResolver.make")(function* (options: {
  readonly drivers: ReadonlyArray<SecretProviderDriver>;
  readonly secretProviders: Effect.Effect<ServerSettings["secretProviders"]>;
  readonly cacheTtlMs?: number;
}) {
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const context = yield* Effect.context<SecretProviderDriverServices>();
  const driversByKind = new Map(
    options.drivers.map((driver) => [
      driver.kind,
      { driver, decodeConfig: decodeConfigWith(driver.definition.configSchema) },
    ]),
  );
  const cache = new Map<string, CachedSecret>();
  const semaphore = yield* Semaphore.make(1);

  // Only a provider this build can read is cached; anything else fails fast and is checked again
  // on the next read.
  const planFor = (
    providers: ServerSettings["secretProviders"],
    reference: SecretReference,
  ): ReadablePlan | undefined => {
    const provider = providers[reference.provider];
    const entry = provider === undefined ? undefined : driversByKind.get(provider.kind);
    if (provider === undefined || entry === undefined) return undefined;
    const { driver, decodeConfig } = entry;
    if (!driver.definition.isReference(reference.reference)) return undefined;
    const config = decodeConfig(provider.config);
    return Option.isNone(config)
      ? undefined
      : { driver, config: config.value, configKey: JSON.stringify(config.value) };
  };

  const isCached = (reference: SecretReference, plan: ReadablePlan, now: number) => {
    const entry = cache.get(cacheKey(reference));
    return entry !== undefined && entry.config === plan.configKey && entry.expiresAt > now;
  };

  // Drop the plaintext when it expires even if nothing reads it again.
  const store = (key: string, entry: CachedSecret) => {
    cache.set(key, entry);
    const timer = setTimeout(() => {
      if (cache.get(key) === entry) cache.delete(key);
    }, cacheTtlMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const answer = (
    references: ReadonlyArray<SecretReference>,
    plans: ReadonlyArray<ReadablePlan | undefined>,
    now: number,
  ) =>
    references.map((reference, index) => {
      const plan = plans[index];
      return plan !== undefined && isCached(reference, plan, now)
        ? cache.get(cacheKey(reference))?.value
        : undefined;
    });

  // Cache hits answer without the lock, so a read waiting on an unlock never stalls a cached one.
  const read: SecretResolver["Service"]["read"] = Effect.fn("SecretResolver.read")(function* (
    references,
    readOptions,
  ) {
    const fresh = readOptions?.fresh === true;
    const providers = yield* options.secretProviders;
    const plans = references.map((reference) => planFor(providers, reference));
    const now = yield* Clock.currentTimeMillis;
    const isMissing = (reference: SecretReference, index: number) => {
      const plan = plans[index];
      return plan !== undefined && (fresh || !isCached(reference, plan, now));
    };
    if (!references.some(isMissing)) return answer(references, plans, now);

    return yield* semaphore.withPermits(1)(
      Effect.gen(function* () {
        const wanted = new Map<
          string,
          {
            readonly plan: ReadablePlan;
            readonly byReference: Map<string, Array<SecretReference>>;
          }
        >();
        references.forEach((reference, index) => {
          const plan = plans[index];
          if (plan === undefined || !isMissing(reference, index)) return;
          const group = wanted.get(reference.provider) ?? { plan, byReference: new Map() };
          group.byReference.set(reference.reference, [
            ...(group.byReference.get(reference.reference) ?? []),
            reference,
          ]);
          wanted.set(reference.provider, group);
        });
        const answered = new Map<string, string | undefined>();
        for (const { plan, byReference } of wanted.values()) {
          const values = yield* plan.driver.read(plan.config, [...byReference.keys()]);
          const readAt = yield* Clock.currentTimeMillis;
          [...byReference.values()].forEach((sameReference, index) => {
            const value = values[index];
            const readable = value !== undefined && value.trim() !== "";
            for (const reference of sameReference) {
              answered.set(cacheKey(reference), value);
              if (!fresh || readable || !isCached(reference, plan, readAt)) {
                store(cacheKey(reference), {
                  config: plan.configKey,
                  value,
                  expiresAt: readAt + cacheTtlMs,
                });
              }
            }
          });
        }
        if (fresh) return references.map((reference) => answered.get(cacheKey(reference)));
        const cached = answer(references, plans, now);
        return references.map((reference, index) =>
          answered.has(cacheKey(reference)) ? answered.get(cacheKey(reference)) : cached[index],
        );
      }),
    );
  }, Effect.provideContext(context));

  const invalidate: SecretResolver["Service"]["invalidate"] = (references) =>
    semaphore.withPermits(1)(
      Effect.sync(() => {
        if (references === undefined) cache.clear();
        else for (const reference of references) cache.delete(cacheKey(reference));
      }),
    );

  const label: SecretResolver["Service"]["label"] = (provider) =>
    options.secretProviders.pipe(
      Effect.map(
        (providers) =>
          (Object.hasOwn(providers, provider) ? providers[provider]?.label.trim() : undefined) ||
          provider,
      ),
    );

  return SecretResolver.of({ read, invalidate, label });
});

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(SecretResolver, make(options));
