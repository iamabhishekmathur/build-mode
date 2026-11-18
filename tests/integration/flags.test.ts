// Real vendor SDKs (GrowthBook, Unleash, OpenFeature server) against the real proxy, in Node.
// The browser SDKs (OpenFeature web, LaunchDarkly v3/v4) are covered in tests/e2e/flags.test.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrowthBook } from '@growthbook/growthbook';
import { UnleashClient } from 'unleash-proxy-client';
import { OpenFeature } from '@openfeature/server-sdk';
import { startServer, type Engine, type StagecraftServer } from '@stagecraft/server';
import { StagecraftServerProvider } from '@stagecraft/flags/openfeature-server';
import { REPO, freePort, until } from '../helpers.ts';

const EX = join(REPO, 'examples/ref-flags');
let server: StagecraftServer;
let engine: Engine;
let base: string;
let root: string;

/** The URL the Stagecraft runtime/preload would send a vendor host to. */
const mockBase = (origin: string) => `${base}/__stagecraft/mock/${encodeURIComponent(origin)}`;

beforeAll(async () => {
  root = join(REPO, 'tests/.tmp', `flags-${Date.now().toString(36)}`);
  mkdirSync(root, { recursive: true });
  cpSync(join(EX, 'stagecraft'), join(root, 'stagecraft'), { recursive: true });
  cpSync(join(EX, 'stagecraft.config.ts'), join(root, 'stagecraft.config.ts'));
  const s = await startServer(join(root, 'stagecraft.config.ts'), { port: 0, devUrl: 'http://127.0.0.1:9', watch: false, log: () => {} });
  ({ server, engine } = s);
  base = s.url;
});

afterAll(async () => {
  await OpenFeature.close();
  await server?.close();
});

describe('LaunchDarkly endpoints over HTTP', () => {
  it('serves evalx (GET and REPORT) from the session flags; SDK telemetry is not a mock-DB write', async () => {
    const s = engine.getSession('ld');
    engine.patch(s, { flags: { 'ld-banner': 'sale' } });
    const ctx = Buffer.from(JSON.stringify({ kind: 'user', key: 'u' })).toString('base64url');
    const h = { 'x-stagecraft-session': 'ld' };
    const get = await fetch(`${mockBase('https://app.launchdarkly.com')}/sdk/evalx/env-1/contexts/${ctx}?withReasons=true`, { headers: h });
    expect(get.headers.get('content-type')).toMatch(/^application\/json/);
    expect((await get.json())['ld-banner']).toMatchObject({ value: 'sale', variation: 1, reason: { kind: 'FALLTHROUGH' } });
    let dbEvents = 0;
    s.listeners.add((e) => e.type === 'db' && dbEvents++);
    const report = await fetch(`${mockBase('https://clientsdk.launchdarkly.com')}/sdk/evalx/env-1/context`, { method: 'REPORT', headers: { ...h, 'content-type': 'application/json' }, body: '{"kind":"user","key":"u"}' });
    expect((await report.json())['ld-banner'].value).toBe('sale');
    const ev = await fetch(`${mockBase('https://events.launchdarkly.com')}/events/bulk/env-1`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '[]' });
    expect(ev.status).toBe(202);
    const stream = await fetch(`${mockBase('https://clientstream.launchdarkly.com')}/eval/env-1/${ctx}`, { headers: h });
    expect(stream.status).toBe(204);
    expect(dbEvents).toBe(0);
    expect([...engine.unmocked.keys()]).toEqual([]);
  });
});

describe('GrowthBook SDK (real) against growthbookMocks', () => {
  it('reads features and refreshes after a panel change', async () => {
    const s = engine.getSession('gb');
    const gb = new GrowthBook({ apiHost: mockBase('https://cdn.growthbook.io'), clientKey: 'sdk-ref-flags', disableCache: true, apiHostRequestHeaders: { 'x-stagecraft-session': 'gb' } });
    const r = await gb.init({ timeout: 3000 });
    expect(r.success).toBe(true);
    expect(gb.isOn('gb-annual-pricing')).toBe(false);
    engine.patch(s, { flags: { 'gb-annual-pricing': true } });
    await gb.refreshFeatures({ skipCache: true });
    expect(gb.isOn('gb-annual-pricing')).toBe(true);
    expect(gb.getFeatureValue('ld-banner', 'x')).toBe('none');
    gb.destroy();
  });
});

describe('Unleash SDK (real) against unleashMocks', () => {
  it('reads toggles and refetches after a panel change', async () => {
    const s = engine.getSession('un');
    const client = new UnleashClient({
      url: `${mockBase('https://unleash.flagship.example')}/api/frontend`,
      clientKey: 'k',
      appName: 'ref-flags',
      disableMetrics: true,
      refreshInterval: 0,
      customHeaders: { 'x-stagecraft-session': 'un' },
    });
    await new Promise<void>((res) => {
      client.on('ready', () => res());
      void client.start();
    });
    expect(client.isEnabled('unleash-beta-badge')).toBe(false);
    expect(client.getVariant('ld-banner')).toMatchObject({ name: 'none', enabled: true, payload: { type: 'string', value: 'none' } });
    engine.patch(s, { flags: { 'unleash-beta-badge': true } });
    await client.updateToggles();
    expect(client.isEnabled('unleash-beta-badge')).toBe(true);
    client.stop();
  });
});

describe('production build of the reference app (FR-507)', () => {
  it('ships the adapters (no-ops in production) but no vendor mock code', async () => {
    const { build } = await import('vite');
    const outDir = join(root, 'dist');
    await build({ root: EX, logLevel: 'silent', build: { outDir, emptyOutDir: true, minify: false } });
    const js = readdirSync(join(outDir, 'assets')).filter((f) => f.endsWith('.js'));
    const code = js.map((f) => readFileSync(join(outDir, 'assets', f), 'utf8')).join('\n');
    expect(code).toContain('StagecraftProvider');
    for (const marker of ['ldMocks', 'toLaunchDarklyFlags', 'pickFlags', 'toUnleashToggles', 'growthbookMocks']) expect(code, marker).not.toContain(marker);
  }, 60000);
});

describe('OpenFeature server provider', () => {
  it('reads the flags of the session given in the evaluation context', async () => {
    engine.patch(engine.getSession('of'), { flags: { 'of-new-checkout': true } });
    await OpenFeature.setProviderAndWait(new StagecraftServerProvider({ proxyUrl: base }));
    const c = OpenFeature.getClient();
    expect(await c.getBooleanDetails('of-new-checkout', false, { stagecraftSession: 'of' })).toMatchObject({ value: true, reason: 'STATIC' });
    expect(await c.getBooleanValue('of-new-checkout', true, { stagecraftSession: 'other' })).toBe(false);
    expect(await c.getStringDetails('nope', 'd', { stagecraftSession: 'of' })).toMatchObject({ value: 'd', reason: 'DEFAULT' });
  });

  it('under the preload, SSR code reads the session of the incoming page request', async () => {
    engine.patch(engine.getSession('ssr'), { flags: { 'of-new-checkout': true } });
    const app = join(root, 'ssr-app.mjs');
    writeFileSync(
      app,
      `import http from 'node:http';
import { OpenFeature } from '@openfeature/server-sdk';
import { StagecraftServerProvider } from '@stagecraft/flags/openfeature-server';
await OpenFeature.setProviderAndWait(new StagecraftServerProvider());
const client = OpenFeature.getClient();
http.createServer(async (req, res) => {
  const v = await client.getBooleanValue('of-new-checkout', false);
  res.end(String(v));
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready'));
`,
    );
    const port = await freePort();
    const child: ChildProcess = spawn(process.execPath, ['--import', '@stagecraft/server/preload', app], {
      cwd: REPO,
      env: { ...process.env, PORT: String(port), STAGECRAFT_PROXY: base, STAGECRAFT_API_ORIGINS: '[]' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await until(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok, 15000, 100);
      // The proxy adds this header to every request it forwards to the dev server.
      const read = (sid: string) => fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-stagecraft-session': sid } }).then((r) => r.text());
      expect(await read('ssr')).toBe('true');
      expect(await read('main')).toBe('false');
    } finally {
      child.kill();
    }
  });
});
