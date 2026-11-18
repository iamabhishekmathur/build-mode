import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryProvider, OpenFeature, ProviderEvents } from '@openfeature/web-sdk';
import type { Json } from '@stagecraft/core';
import { StagecraftProvider, resolveFromFlags } from '@stagecraft/flags/openfeature';
import { changedKeys } from '@stagecraft/flags';
import { ldMocks, launchDarklyVariation, pickFlags, toGrowthBookPayload, toLaunchDarklyFlags, toUnleashToggles, unleashMocks, growthbookMocks } from '@stagecraft/flags/mocks';

/** A stand-in for window.__STAGECRAFT__ with just what the adapters use. */
function fakeRuntime(flags: Record<string, Json>) {
  const listeners = new Map<string, Set<(d: any) => void>>();
  const rt = {
    info: { flags },
    on(e: string, fn: (d: any) => void) {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(fn);
      return () => listeners.get(e)!.delete(fn);
    },
    /** What the runtime does when the proxy reports a flag change. */
    setFlags(next: Record<string, Json>, reason: 'ui' | 'data' = 'ui') {
      rt.info = { flags: next };
      listeners.get(reason)?.forEach((fn) => fn(rt.info));
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
  return rt;
}

function installRuntime(rt: ReturnType<typeof fakeRuntime>) {
  (globalThis as any).window = { __STAGECRAFT__: rt };
}

afterEach(async () => {
  await OpenFeature.clearProviders();
  OpenFeature.clearHandlers();
  delete (globalThis as any).window;
});

describe('resolveFromFlags', () => {
  const flags = { on: true, label: 'cards', n: 3, obj: { a: 1 }, list: [1, 2] };
  it('returns STATIC for flags Stagecraft defines', () => {
    expect(resolveFromFlags(flags, 'boolean', 'on', false)).toMatchObject({ value: true, reason: 'STATIC', variant: 'true' });
    expect(resolveFromFlags(flags, 'string', 'label', 'x')).toMatchObject({ value: 'cards', reason: 'STATIC', variant: 'cards' });
    expect(resolveFromFlags(flags, 'number', 'n', 0)).toMatchObject({ value: 3, reason: 'STATIC' });
    expect(resolveFromFlags(flags, 'object', 'obj', {})).toMatchObject({ value: { a: 1 }, reason: 'STATIC' });
    expect(resolveFromFlags(flags, 'object', 'list', [])).toMatchObject({ value: [1, 2], reason: 'STATIC' });
  });
  it('returns the default with reason DEFAULT for unknown flags', () => {
    expect(resolveFromFlags(flags, 'boolean', 'nope', true)).toEqual({ value: true, reason: 'DEFAULT', flagMetadata: { source: 'stagecraft' } });
  });
  it('returns the default with TYPE_MISMATCH for the wrong type', () => {
    expect(resolveFromFlags(flags, 'boolean', 'label', false)).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'TYPE_MISMATCH' });
  });
});

describe('StagecraftProvider (OpenFeature web SDK)', () => {
  it('resolves from the Stagecraft runtime and emits ConfigurationChanged on panel changes', async () => {
    const rt = fakeRuntime({ 'new-checkout': false, layout: 'table' });
    installRuntime(rt);
    const fallback = new InMemoryProvider({ 'new-checkout': { variants: { on: true }, defaultVariant: 'on', disabled: false } });
    const init = vi.fn(async () => {});
    (fallback as any).initialize = init;
    const resolve = vi.spyOn(fallback, 'resolveBooleanEvaluation');
    const provider = new StagecraftProvider({ fallback });
    expect(provider.usingStagecraft).toBe(true);
    await OpenFeature.setProviderAndWait(provider);
    const client = OpenFeature.getClient();
    expect(client.getBooleanDetails('new-checkout', true)).toMatchObject({ value: false, reason: 'STATIC' });
    expect(client.getStringValue('layout', 'x')).toBe('table');
    expect(client.getNumberDetails('missing', 7)).toMatchObject({ value: 7, reason: 'DEFAULT' });
    // The real provider is never initialized under Stagecraft: no network call to the vendor.
    expect(init).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();

    const changes: string[][] = [];
    client.addHandler(ProviderEvents.ConfigurationChanged, (e) => changes.push(e?.flagsChanged ?? []));
    rt.setFlags({ 'new-checkout': true, layout: 'table' });
    expect(client.getBooleanValue('new-checkout', false)).toBe(true);
    // A persona/state change ('data') that changes a forced flag also counts.
    rt.setFlags({ 'new-checkout': true, layout: 'cards' }, 'data');
    // No change, no event.
    rt.setFlags({ 'new-checkout': true, layout: 'cards' });
    await vi.waitFor(() => expect(changes).toEqual([['new-checkout'], ['layout']]));

    await OpenFeature.clearProviders();
    expect(rt.listenerCount()).toBe(0);
  });

  it('delegates to the fallback provider when the runtime is absent (production)', async () => {
    const fallback = new InMemoryProvider({ 'new-checkout': { variants: { on: true, off: false }, defaultVariant: 'on', disabled: false } });
    const provider = new StagecraftProvider({ fallback });
    expect(provider.usingStagecraft).toBe(false);
    expect(provider.events).toBe(fallback.events);
    await OpenFeature.setProviderAndWait(provider);
    const d = OpenFeature.getClient().getBooleanDetails('new-checkout', false);
    expect(d).toMatchObject({ value: true, reason: 'STATIC', variant: 'on' });
  });

  it('returns defaults with no runtime and no fallback', async () => {
    await OpenFeature.setProviderAndWait(new StagecraftProvider());
    expect(OpenFeature.getClient().getStringDetails('x', 'dflt')).toMatchObject({ value: 'dflt', reason: 'DEFAULT' });
  });
});

describe('vendor payload mapping', () => {
  it('changedKeys compares by value', () => {
    expect(changedKeys({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 2 }, c: true })).toEqual(['b', 'c']);
  });

  it('pickFlags limits and extends what the SDK sees', () => {
    expect(pickFlags({ a: 1, b: 2 }, { flags: ['a'], extra: { z: true, a: 0 } })).toEqual({ z: true, a: 1 });
  });

  it('maps to the LaunchDarkly client-side flag shape', () => {
    const defs = { banner: { default: 'none', options: ['none', 'sale', 'holiday'] } };
    expect(toLaunchDarklyFlags({ banner: 'holiday', on: true, off: false, n: 4 }, { defs, version: 9 })).toEqual({
      banner: { value: 'holiday', variation: 2, version: 9, flagVersion: 9, trackEvents: false },
      on: { value: true, variation: 0, version: 9, flagVersion: 9, trackEvents: false },
      off: { value: false, variation: 1, version: 9, flagVersion: 9, trackEvents: false },
      n: { value: 4, variation: 0, version: 9, flagVersion: 9, trackEvents: false },
    });
    expect(toLaunchDarklyFlags({ a: true }, { withReasons: true }).a!.reason).toEqual({ kind: 'FALLTHROUGH' });
    expect(launchDarklyVariation('x')).toBe(0);
  });

  it('ldMocks covers the SDK endpoints and answers from the session flags', async () => {
    const m = ldMocks({ flags: ['ld-a'] });
    expect(m.apiOrigins).toContain('https://clientsdk.launchdarkly.com');
    expect(Object.keys(m.handlers).sort()).toEqual([
      'GET /eval/:env/:context',
      'GET /ping/:env',
      'GET /sdk/evalx/:env/contexts/:context',
      'GET /sdk/goals/:env',
      'POST /events/bulk/:env',
      'POST /events/diagnostic/:env',
      'REPORT /eval/:env',
      'REPORT /sdk/evalx/:env/context',
    ]);
    const ctx: any = { flags: { 'ld-a': 'x', other: 1 }, query: {}, reply: (status: number, body?: unknown) => ({ __stagecraftReply: true, status, body }) };
    const r: any = await m.handlers['REPORT /sdk/evalx/:env/context']!(ctx);
    expect(r).toMatchObject({ status: 200, readOnly: true, body: { 'ld-a': { value: 'x', variation: 0, trackEvents: false } } });
    expect(Object.keys(r.body)).toEqual(['ld-a']);
    expect(await m.handlers['POST /events/bulk/:env']!(ctx)).toMatchObject({ status: 202, readOnly: true });
    expect(await m.handlers['GET /eval/:env/:context']!(ctx)).toMatchObject({ status: 204 });
  });

  it('maps to GrowthBook and Unleash payloads', () => {
    expect(toGrowthBookPayload({ a: true, b: 'x' }).features).toEqual({ a: { defaultValue: true }, b: { defaultValue: 'x' } });
    expect(toUnleashToggles({ on: true, off: false, s: 'blue', n: 2, o: { k: 1 } })).toEqual([
      { name: 'on', enabled: true, variant: { name: 'disabled', enabled: false }, impressionData: false },
      { name: 'off', enabled: false, variant: { name: 'disabled', enabled: false }, impressionData: false },
      { name: 's', enabled: true, variant: { name: 'blue', enabled: true, payload: { type: 'string', value: 'blue' } }, impressionData: false },
      { name: 'n', enabled: true, variant: { name: '2', enabled: true, payload: { type: 'number', value: '2' } }, impressionData: false },
      { name: 'o', enabled: true, variant: { name: 'json', enabled: true, payload: { type: 'json', value: '{"k":1}' } }, impressionData: false },
    ]);
    expect(unleashMocks({ url: 'https://u.example/api/frontend/' })).toMatchObject({ apiOrigins: ['https://u.example'] });
    expect(Object.keys(unleashMocks({ url: 'https://u.example/api/frontend' }).handlers)).toEqual(['GET /api/frontend', 'POST /api/frontend', 'POST /api/frontend/client/metrics']);
    expect(Object.keys(growthbookMocks({ apiHost: 'https://gb.acme.com/proxy' }).handlers)).toEqual(['GET /proxy/api/features/:clientKey']);
  });
});
