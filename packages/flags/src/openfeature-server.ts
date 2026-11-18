import { ErrorCode, StandardResolutionReasons, type EvaluationContext, type Hook, type JsonValue, type Logger, type Provider, type ResolutionDetails } from '@openfeature/server-sdk';
import type { Json } from '@stagecraft/core';
import { resolveFromFlags, type Kind } from './resolve.ts';

export interface StagecraftServerProviderOptions {
  /** The real server provider. Used only when the app does not run under `stagecraft dev`. */
  fallback?: Provider;
  /** Proxy URL. Default: `STAGECRAFT_PROXY`, which `stagecraft dev` sets for the dev server. */
  proxyUrl?: string;
}

const SESSION_HEADER = 'x-stagecraft-session';

/**
 * OpenFeature server provider (Node SSR, React Server Components, API routes) backed by Stagecraft.
 *
 * Under `stagecraft dev` each evaluation reads the effective flags of the Stagecraft session that
 * the current page request belongs to: it calls the proxy's control API with `fetch`, and the
 * Stagecraft preload (`node --import @stagecraft/server/preload`) tags that call with the session
 * of the incoming request. Code outside a request can pass the session explicitly with the
 * evaluation context attribute `stagecraftSession`. Without `STAGECRAFT_PROXY` it delegates to
 * `fallback` (production).
 */
export class StagecraftServerProvider implements Provider {
  readonly metadata = { name: 'stagecraft-server' } as const;
  readonly runsOn = 'server' as const;
  readonly hooks?: Hook[];
  readonly events?: Provider['events'];
  private fallback?: Provider;
  private proxy: string | undefined;

  constructor(opts: StagecraftServerProviderOptions = {}) {
    this.fallback = opts.fallback;
    this.proxy = opts.proxyUrl ?? (typeof process !== 'undefined' ? process.env.STAGECRAFT_PROXY : undefined);
    if (!this.proxy) {
      this.hooks = this.fallback?.hooks;
      this.events = this.fallback?.events;
    }
  }

  get usingStagecraft() {
    return !!this.proxy;
  }

  async initialize(context?: EvaluationContext): Promise<void> {
    if (!this.proxy) await this.fallback?.initialize?.(context);
  }

  async onClose(): Promise<void> {
    if (!this.proxy) await this.fallback?.onClose?.();
  }

  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext, logger: Logger) {
    return this.resolve('boolean', flagKey, defaultValue, context, logger);
  }

  resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext, logger: Logger) {
    return this.resolve('string', flagKey, defaultValue, context, logger);
  }

  resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext, logger: Logger) {
    return this.resolve('number', flagKey, defaultValue, context, logger);
  }

  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context: EvaluationContext, logger: Logger) {
    return this.resolve('object', flagKey, defaultValue, context, logger);
  }

  /** Effective flags of the session (the request's, or `context.stagecraftSession`). */
  async sessionFlags(context: EvaluationContext = {}): Promise<Record<string, Json>> {
    const headers: Record<string, string> = {};
    const sid = context.stagecraftSession;
    if (typeof sid === 'string' && sid) headers[SESSION_HEADER] = sid;
    // globalThis.fetch at call time: the Stagecraft preload patches it to add the request's session.
    const res = await globalThis.fetch(new URL('/__stagecraft/api/session', this.proxy).href, { headers });
    if (!res.ok) throw new Error(`Stagecraft proxy answered ${res.status}`);
    const body = (await res.json()) as { flags?: Record<string, Json> };
    return body.flags ?? {};
  }

  private async resolve<T>(kind: Kind, flagKey: string, defaultValue: T, context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<T>> {
    if (!this.proxy) {
      const f = this.fallback as any;
      if (!f) return { value: defaultValue, reason: StandardResolutionReasons.DEFAULT };
      const method = { boolean: 'resolveBooleanEvaluation', string: 'resolveStringEvaluation', number: 'resolveNumberEvaluation', object: 'resolveObjectEvaluation' }[kind];
      return f[method](flagKey, defaultValue, context, logger);
    }
    let flags: Record<string, Json>;
    try {
      flags = await this.sessionFlags(context);
    } catch (e) {
      // Never fall through to the real vendor during prototyping.
      return { value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.GENERAL, errorMessage: `Stagecraft: ${(e as Error).message}` };
    }
    return resolveFromFlags(flags, kind, flagKey, defaultValue);
  }
}
