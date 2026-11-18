import {
  OpenFeatureEventEmitter,
  ProviderEvents,
  StandardResolutionReasons,
  type EvaluationContext,
  type Hook,
  type JsonValue,
  type Logger,
  type Provider,
  type ResolutionDetails,
  type TrackingEventDetails,
} from '@openfeature/web-sdk';
import type { Json } from '@stagecraft/core';
import { resolveFromFlags, type Kind } from './resolve.ts';
import { onStagecraftFlags, stagecraftRuntime } from './runtime.ts';

export { resolveFromFlags };

export interface StagecraftProviderOptions {
  /**
   * The real provider (LaunchDarkly, Flagsmith, flagd, ...). Used only when the Stagecraft
   * runtime is absent, i.e. in production. Under Stagecraft it is never initialized, so it
   * makes no network call to the vendor.
   */
  fallback?: Provider;
}

/**
 * OpenFeature web provider backed by Stagecraft flags.
 *
 * Under the Stagecraft proxy it resolves every flag from `window.__STAGECRAFT__.flag(key, default)`
 * (config defaults, then state-forced flags, then the session's panel/MCP overrides) and emits
 * `ConfigurationChanged` when those change, so OpenFeature React hooks re-render.
 * Without the runtime it delegates everything to `fallback`, or returns the default values.
 *
 *   OpenFeature.setProvider(new StagecraftProvider({ fallback: new LaunchDarklyClientProvider(...) }));
 */
export class StagecraftProvider implements Provider {
  readonly metadata = { name: 'stagecraft' } as const;
  readonly runsOn = 'client' as const;
  readonly events?: OpenFeatureEventEmitter;
  readonly hooks?: Hook[];
  private fallback?: Provider;
  private active: boolean;
  private off: (() => void) | null = null;

  constructor(opts: StagecraftProviderOptions = {}) {
    this.fallback = opts.fallback;
    this.active = !!stagecraftRuntime();
    if (this.active) {
      this.events = new OpenFeatureEventEmitter();
    } else {
      // Production: behave exactly like the wrapped provider (its events and hooks too).
      this.events = this.fallback?.events as OpenFeatureEventEmitter | undefined;
      this.hooks = this.fallback?.hooks;
    }
  }

  /** True when flags come from Stagecraft rather than the fallback provider. */
  get usingStagecraft() {
    return this.active;
  }

  async initialize(context?: EvaluationContext): Promise<void> {
    if (!this.active) {
      await this.fallback?.initialize?.(context);
      return;
    }
    this.off?.();
    this.off = onStagecraftFlags((changed) => {
      this.events?.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: changed, providerName: this.metadata.name });
    });
  }

  async onClose(): Promise<void> {
    if (!this.active) return this.fallback?.onClose?.();
    this.off?.();
    this.off = null;
  }

  onContextChange(oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void> | void {
    // Under Stagecraft the persona drives targeting, not the evaluation context.
    if (!this.active) return this.fallback?.onContextChange?.(oldContext, newContext);
  }

  track(name: string, context: EvaluationContext, details: TrackingEventDetails): void {
    if (!this.active) this.fallback?.track?.(name, context, details);
  }

  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext, logger: Logger): ResolutionDetails<boolean> {
    if (!this.active) return this.delegate('boolean', flagKey, defaultValue, context, logger);
    return resolveFromFlags(currentFlags(), 'boolean', flagKey, defaultValue);
  }

  resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext, logger: Logger): ResolutionDetails<string> {
    if (!this.active) return this.delegate('string', flagKey, defaultValue, context, logger);
    return resolveFromFlags(currentFlags(), 'string', flagKey, defaultValue);
  }

  resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext, logger: Logger): ResolutionDetails<number> {
    if (!this.active) return this.delegate('number', flagKey, defaultValue, context, logger);
    return resolveFromFlags(currentFlags(), 'number', flagKey, defaultValue);
  }

  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context: EvaluationContext, logger: Logger): ResolutionDetails<T> {
    if (!this.active) return this.delegate('object', flagKey, defaultValue, context, logger);
    return resolveFromFlags(currentFlags(), 'object', flagKey, defaultValue);
  }

  private delegate<T>(kind: Kind, flagKey: string, defaultValue: T, context: EvaluationContext, logger: Logger): ResolutionDetails<T> {
    const f = this.fallback as any;
    if (!f) return { value: defaultValue, reason: StandardResolutionReasons.DEFAULT };
    const method = { boolean: 'resolveBooleanEvaluation', string: 'resolveStringEvaluation', number: 'resolveNumberEvaluation', object: 'resolveObjectEvaluation' }[kind];
    return f[method](flagKey, defaultValue, context, logger);
  }
}

function currentFlags(): Record<string, Json> {
  return stagecraftRuntime()?.info.flags ?? {};
}
