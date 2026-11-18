/**
 * Built-in mock handlers for feature-flag vendor endpoints.
 *
 * Each factory returns `{ apiOrigins, handlers }` to spread into `stagecraft.config.ts`. The real
 * vendor SDK keeps its normal hosts; the Stagecraft runtime (browser) and preload (Node SSR) send
 * those hosts to the proxy, and these handlers answer with the session's effective flags
 * (config defaults < state-forced flags < panel/MCP overrides). Nothing reaches the vendor.
 *
 * Endpoints were read from the installed SDK sources; see docs/flags.md for files and versions.
 */
import type { FlagDef, Json, MockContext, MockHandler, MockReply } from '@stagecraft/core';

export interface VendorMocks {
  apiOrigins: string[];
  handlers: Record<string, MockHandler>;
}

export interface VendorMockOptions {
  /** Stagecraft flag keys to expose to the SDK. Default: every effective flag of the session. */
  flags?: string[];
  /** Fixed values for vendor flags that Stagecraft does not define. Session flags win. */
  extra?: Record<string, Json>;
}

/** Flags the SDK sees for this request. */
export function pickFlags(all: Record<string, Json>, opts: VendorMockOptions = {}): Record<string, Json> {
  const out: Record<string, Json> = { ...(opts.extra ?? {}) };
  for (const [k, v] of Object.entries(all)) if (!opts.flags || opts.flags.includes(k)) out[k] = v;
  return out;
}

/** A reply that does not count as a mock-DB write (SDK telemetry, flag evaluation via POST/REPORT). */
function readOnly(ctx: MockContext, status: number, body?: unknown, headers?: Record<string, string>): MockReply {
  return { ...ctx.reply(status, body, headers), readOnly: true };
}

// ---------------------------------------------------------------- LaunchDarkly

export const LAUNCHDARKLY_HOSTS = [
  'https://app.launchdarkly.com', // launchdarkly-js-client-sdk v3: polling + goals
  'https://clientsdk.launchdarkly.com', // @launchdarkly/js-client-sdk v4: polling + goals
  'https://clientstream.launchdarkly.com', // streaming (both)
  'https://events.launchdarkly.com', // analytics + diagnostic events (both)
];

export interface LaunchDarklyFlag {
  value: Json;
  variation: number;
  version: number;
  flagVersion: number;
  trackEvents: false;
  reason?: { kind: string };
}

export interface LaunchDarklyMockOptions extends VendorMockOptions {
  /** Flag definitions (your config `flags`), so `variation` is the index in `options`. */
  defs?: Record<string, FlagDef>;
  /** Hosts to intercept. Default: LaunchDarkly's public client-side hosts. Add your relay proxy. */
  hosts?: string[];
}

/** Variation index LaunchDarkly would report: index in `options`, booleans true=0/false=1, else 0. */
export function launchDarklyVariation(value: Json, def?: FlagDef): number {
  const i = def?.options?.findIndex((o) => JSON.stringify(o) === JSON.stringify(value)) ?? -1;
  if (i >= 0) return i;
  if (typeof value === 'boolean') return value ? 0 : 1;
  return 0;
}

/** Map Stagecraft flag values to the client-side evaluation payload (`/sdk/evalx`, stream `put`). */
export function toLaunchDarklyFlags(
  flags: Record<string, Json>,
  opts: { defs?: Record<string, FlagDef>; version?: number; withReasons?: boolean } = {},
): Record<string, LaunchDarklyFlag> {
  const version = opts.version ?? 1;
  const out: Record<string, LaunchDarklyFlag> = {};
  for (const [key, value] of Object.entries(flags)) {
    out[key] = {
      value,
      variation: launchDarklyVariation(value, opts.defs?.[key]),
      version,
      flagVersion: version,
      trackEvents: false,
      ...(opts.withReasons ? { reason: { kind: 'FALLTHROUGH' } } : {}),
    };
  }
  return out;
}

// Grows on every evaluation response, so a later payload never looks older than an earlier one.
let ldVersion = 0;

/**
 * Mocks for the LaunchDarkly client-side SDKs (`launchdarkly-js-client-sdk` v3 and
 * `@launchdarkly/js-client-sdk` v4, FDv1 data system):
 *
 * - `GET /sdk/evalx/:env/contexts/:ctx` and `REPORT /sdk/evalx/:env/context` (polling, `useReport`)
 * - `GET /sdk/goals/:env` (click/page-view goals) → `[]`
 * - streaming `GET /eval/:env/:ctx`, `REPORT /eval/:env`, `GET /ping/:env` → 204. The proxy's
 *   mock handlers cannot hold an SSE stream open, so the SDK sees a failed stream and retries
 *   with its backoff (1 s doubling to 30 s). Flag values still come from polling; to see panel
 *   changes live, call `syncLaunchDarkly(client)` (from `@stagecraft/flags`).
 * - `POST /events/bulk/:env`, `POST /events/diagnostic/:env` → 202, discarded.
 */
export function ldMocks(opts: LaunchDarklyMockOptions = {}): VendorMocks {
  const evalx: MockHandler = (ctx) =>
    readOnly(
      ctx,
      200,
      toLaunchDarklyFlags(pickFlags(ctx.flags, opts), { defs: opts.defs, version: ++ldVersion, withReasons: ctx.query.withReasons === 'true' }),
    );
  const noStream: MockHandler = (ctx) => readOnly(ctx, 204);
  const accepted: MockHandler = (ctx) => readOnly(ctx, 202);
  return {
    apiOrigins: opts.hosts ?? LAUNCHDARKLY_HOSTS,
    handlers: {
      'GET /sdk/evalx/:env/contexts/:context': evalx,
      'REPORT /sdk/evalx/:env/context': evalx,
      'GET /sdk/goals/:env': () => [],
      'GET /eval/:env/:context': noStream,
      'REPORT /eval/:env': noStream,
      'GET /ping/:env': noStream,
      'POST /events/bulk/:env': accepted,
      'POST /events/diagnostic/:env': accepted,
    },
  };
}

// ---------------------------------------------------------------- GrowthBook

export interface GrowthBookMockOptions extends VendorMockOptions {
  /** `apiHost` the SDK uses. Default `https://cdn.growthbook.io`. */
  apiHost?: string;
}

/** Map Stagecraft flags to a GrowthBook features payload: every feature is its `defaultValue`. */
export function toGrowthBookPayload(flags: Record<string, Json>) {
  const features: Record<string, { defaultValue: Json }> = {};
  for (const [k, v] of Object.entries(flags)) features[k] = { defaultValue: v };
  return { status: 200, features, dateUpdated: new Date().toISOString() };
}

/**
 * Mocks for `@growthbook/growthbook` (client-side evaluation): `GET /api/features/:clientKey`.
 * The response has no `x-sse-support` header, so the SDK never opens its `/sub/` stream.
 * Remote evaluation (`POST /api/eval/:clientKey`) is not mocked.
 */
export function growthbookMocks(opts: GrowthBookMockOptions = {}): VendorMocks {
  const host = new URL(opts.apiHost ?? 'https://cdn.growthbook.io');
  const base = host.pathname.replace(/\/$/, '');
  return {
    apiOrigins: [host.origin],
    handlers: {
      [`GET ${base}/api/features/:clientKey`]: (ctx) => toGrowthBookPayload(pickFlags(ctx.flags, opts)),
    },
  };
}

// ---------------------------------------------------------------- Unleash

export interface UnleashToggle {
  name: string;
  enabled: boolean;
  variant: { name: string; enabled: boolean; payload?: { type: 'string' | 'number' | 'json'; value: string } };
  impressionData: false;
}

/**
 * Map Stagecraft flags to Unleash frontend toggles. A boolean is `enabled`; any other value is an
 * enabled toggle whose variant is named after the value and carries it as payload.
 */
export function toUnleashToggles(flags: Record<string, Json>): UnleashToggle[] {
  return Object.entries(flags).map(([name, v]) => {
    if (typeof v === 'boolean' || v === null) return { name, enabled: !!v, variant: { name: 'disabled', enabled: false }, impressionData: false };
    const payload =
      typeof v === 'string'
        ? { type: 'string' as const, value: v }
        : typeof v === 'number'
          ? { type: 'number' as const, value: String(v) }
          : { type: 'json' as const, value: JSON.stringify(v) };
    return { name, enabled: true, variant: { name: typeof v === 'object' ? 'json' : String(v), enabled: true, payload }, impressionData: false };
  });
}

export interface UnleashMockOptions extends VendorMockOptions {
  /** The `url` you give `UnleashClient` (Frontend API or Edge/proxy), e.g. `https://unleash.acme.com/api/frontend`. */
  url: string;
}

/**
 * Mocks for `unleash-proxy-client` (Frontend API): `GET <url>` (context as query string),
 * `POST <url>` (`usePOSTrequests`), and `POST <url>/client/metrics` → 200, discarded.
 */
export function unleashMocks(opts: UnleashMockOptions): VendorMocks {
  const u = new URL(opts.url);
  const path = u.pathname.replace(/\/$/, '') || '/';
  const toggles: MockHandler = (ctx) => readOnly(ctx, 200, { toggles: toUnleashToggles(pickFlags(ctx.flags, opts)) });
  return {
    apiOrigins: [u.origin],
    handlers: {
      [`GET ${path}`]: toggles,
      [`POST ${path}`]: toggles,
      [`POST ${path === '/' ? '' : path}/client/metrics`]: (ctx) => readOnly(ctx, 200, {}),
    },
  };
}

/** Merge several vendor mocks into one `{ apiOrigins, handlers }`. */
export function mergeVendorMocks(...all: VendorMocks[]): VendorMocks {
  return {
    apiOrigins: [...new Set(all.flatMap((m) => m.apiOrigins))],
    handlers: Object.assign({}, ...all.map((m) => m.handlers)),
  };
}
