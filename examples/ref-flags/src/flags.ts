// Product code: the flag SDKs exactly as the product ships them, with their real hosts.
// Stagecraft's only footprint is the OpenFeature provider wrapper and one sync call per SDK;
// both are no-ops in production (no Stagecraft runtime on the page).
import { useSyncExternalStore } from 'react';
import { InMemoryProvider, OpenFeature } from '@openfeature/web-sdk';
import { initialize as ldInitialize } from 'launchdarkly-js-client-sdk';
import { createClient as ldCreateClient } from '@launchdarkly/js-client-sdk';
import { GrowthBook } from '@growthbook/growthbook';
import { UnleashClient } from 'unleash-proxy-client';
import { StagecraftProvider } from '@stagecraft/flags/openfeature';
import { isStagecraft, syncGrowthBook, syncLaunchDarkly, syncUnleash } from '@stagecraft/flags';

// Re-render React when any SDK reports a change.
let version = 0;
const subs = new Set<() => void>();
const bump = () => {
  version++;
  subs.forEach((fn) => fn());
};
export function useFlagsVersion() {
  return useSyncExternalStore(
    (fn) => (subs.add(fn), () => subs.delete(fn)),
    () => version,
  );
}

// ---- OpenFeature. In production the fallback would be your vendor's OpenFeature provider.
OpenFeature.setProvider(
  new StagecraftProvider({
    fallback: new InMemoryProvider({
      'of-new-checkout': { variants: { on: true, off: false }, defaultVariant: 'off', disabled: false },
    }),
  }),
);

// ---- LaunchDarkly, classic browser SDK (launchdarkly-js-client-sdk v3).
const context = { kind: 'user', key: 'demo-user' };
export const ld3 = ldInitialize('ref-flags-client-side-id', context);
ld3.on('change', bump); // subscribing to changes also makes the SDK open its stream
ld3.on('ready', bump);
syncLaunchDarkly(ld3);

// ---- LaunchDarkly, new browser SDK (@launchdarkly/js-client-sdk v4).
export const ld4 = ldCreateClient('ref-flags-client-side-id', context);
ld4.on('change', bump);
ld4.start().then(bump);
syncLaunchDarkly(ld4);

// ---- GrowthBook. Its feature cache is shared per host, so turn it off under Stagecraft:
// otherwise a reload or another session could show stale values for up to a minute.
export const gb = new GrowthBook({ apiHost: 'https://cdn.growthbook.io', clientKey: 'sdk-ref-flags', disableCache: isStagecraft() });
gb.setRenderer(bump);
gb.init({ timeout: 2000 }).then(bump);
syncGrowthBook(gb);

// ---- Unleash (Frontend API).
export const unleash = new UnleashClient({ url: 'https://unleash.flagship.example/api/frontend', clientKey: 'ref-flags-frontend-token', appName: 'ref-flags' });
unleash.on('update', bump);
unleash.on('ready', bump);
unleash.start();
syncUnleash(unleash);
