/**
 * Browser helpers that make a vendor SDK pick up flag changes from the Stagecraft panel live.
 *
 * Vendor SDKs normally learn about flag changes over a streaming connection. Stagecraft's mock
 * handlers answer requests but do not hold streams open, so these helpers ask the SDK to refetch
 * (through its public API) whenever Stagecraft's effective flags change. Each one is a no-op
 * outside Stagecraft, so product code can call it unconditionally.
 */
import { onStagecraftFlags, stagecraftRuntime } from './runtime.ts';

export interface SyncOptions {
  /** `refetch` (default): ask the SDK to refetch. `reload`: reload the page instead. */
  mode?: 'refetch' | 'reload';
}

function sync(refetch: () => unknown, opts: SyncOptions): () => void {
  return onStagecraftFlags(() => {
    if (opts.mode === 'reload') location.reload();
    else Promise.resolve().then(refetch).catch(() => {});
  });
}

/** Structural type: both `launchdarkly-js-client-sdk` v3 and `@launchdarkly/js-client-sdk` v4 clients fit. */
export interface LaunchDarklyLikeClient {
  identify(context: any, ...rest: any[]): Promise<unknown> | unknown;
  getContext(): any;
}

/**
 * LaunchDarkly: on a Stagecraft flag change, re-identify with the current context. The SDK polls
 * `/sdk/evalx/...` again (answered by `ldMocks`) and emits its usual `change` events.
 *
 *   const ld = initialize(clientSideId, context);
 *   syncLaunchDarkly(ld);
 */
export function syncLaunchDarkly(client: LaunchDarklyLikeClient, opts: SyncOptions = {}): () => void {
  return sync(() => client.identify(client.getContext()), opts);
}

/** GrowthBook: on a Stagecraft flag change, refetch features, bypassing the SDK's cache. */
export function syncGrowthBook(gb: { refreshFeatures(o?: { skipCache?: boolean }): Promise<unknown> }, opts: SyncOptions = {}): () => void {
  return sync(() => gb.refreshFeatures({ skipCache: true }), opts);
}

/** Unleash (`unleash-proxy-client`): on a Stagecraft flag change, refetch toggles. */
export function syncUnleash(client: { updateToggles(): Promise<unknown> }, opts: SyncOptions = {}): () => void {
  return sync(() => client.updateToggles(), opts);
}

export { onStagecraftFlags, stagecraftRuntime };
