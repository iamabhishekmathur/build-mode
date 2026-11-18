// FR-403 AC: for each adapter, the reference repo shows the flag changing the UI with no real call
// to the vendor. Real Vite, real proxy, real vendor SDKs (examples/ref-flags), headless Chromium.
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { startServer, type Engine, type StagecraftServer } from '@stagecraft/server';
import { REPO, freePort } from '../helpers.ts';

const EX = join(REPO, 'examples/ref-flags');
let vite: ViteDevServer;
let server: StagecraftServer;
let engine: Engine;
let base: string;
let browser: Browser;
/** Every request that tried to leave the machine (should stay empty). */
let escaped: string[] = [];
/** Every request the page made, after the runtime rewrote it. */
let requests: { method: string; url: string }[] = [];

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])$/;

async function newContext(): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  // Block anything that is not this machine, and record it: the proof that no vendor is called.
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.protocol.startsWith('http') && !LOCAL.test(u.hostname)) {
      escaped.push(`${route.request().method()} ${u.href}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  ctx.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
  return ctx;
}

beforeAll(async () => {
  const { createServer } = await import('vite');
  const port = await freePort();
  vite = await createServer({ root: EX, configFile: join(EX, 'vite.config.ts'), logLevel: 'silent', server: { port, strictPort: true } });
  await vite.listen();
  const root = join(REPO, 'tests/.tmp', `e2e-flags-${Date.now().toString(36)}`);
  mkdirSync(root, { recursive: true });
  cpSync(join(EX, 'stagecraft'), join(root, 'stagecraft'), { recursive: true });
  cpSync(join(EX, 'stagecraft.config.ts'), join(root, 'stagecraft.config.ts'));
  const s = await startServer(join(root, 'stagecraft.config.ts'), { port: 0, devUrl: `http://localhost:${port}`, watch: false, log: () => {} });
  ({ server, engine } = s);
  base = s.url;
  browser = await chromium.launch();
  // Warm up Vite's dependency optimizer so later page loads do not reload mid-test.
  const ctx = await newContext();
  const p = await ctx.newPage();
  await p.goto(base + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await ctx.close();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await vite?.close();
});

beforeEach(() => {
  engine.sessions.clear();
  engine.unmocked.clear();
  escaped = [];
  requests = [];
});

async function open(ctx: BrowserContext, path = '/'): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.locator('stagecraft-panel').waitFor({ state: 'attached' });
  return page;
}

const panel = (page: Page) => page.locator('stagecraft-panel');
const text = (page: Page, id: string) => page.getByTestId(id).textContent();

async function assertNoVendorCalls() {
  expect(escaped).toEqual([]);
  const r = await fetch(`${base}/__stagecraft/api/endpoints`).then((x) => x.json());
  expect(r.unmocked).toEqual([]);
}

describe('FR-403: vendor flag adapters, toggled from the Stagecraft panel', () => {
  it('(a) OpenFeature: the panel flag changes the UI live, with no vendor call', async () => {
    const ctx = await newContext();
    const page = await open(ctx);
    await expect.poll(() => text(page, 'of-checkout')).toBe('Classic three-step checkout');
    await page.evaluate(() => ((window as any).__noReload = true));
    await panel(page).getByLabel('of-new-checkout').check();
    await expect.poll(() => text(page, 'of-checkout')).toBe('New one-page checkout');
    await panel(page).getByLabel('of-new-checkout').uncheck();
    await expect.poll(() => text(page, 'of-checkout')).toBe('Classic three-step checkout');
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
    await assertNoVendorCalls();
    await ctx.close();
  });

  it('(b) LaunchDarkly, v3 and v4 SDKs: the panel flag changes the UI live, with no vendor call', async () => {
    const ctx = await newContext();
    const page = await open(ctx);
    await expect.poll(() => text(page, 'ld-banner')).toBe('No promotion');
    await expect.poll(() => text(page, 'ld4-header')).toBe('Tall header');
    await page.evaluate(() => ((window as any).__noReload = true));
    await panel(page).getByLabel('ld-banner').selectOption('"holiday"');
    await expect.poll(() => text(page, 'ld-banner')).toBe('Happy holidays: free shipping');
    await panel(page).getByLabel('ld4-compact-header').check();
    await expect.poll(() => text(page, 'ld4-header')).toBe('Compact header');
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);

    // The SDKs called their real endpoints; the runtime sent them to the proxy's mocks.
    const ld = requests.filter((r) => r.url.includes(encodeURIComponent('launchdarkly.com')));
    const paths = ld.map((r) => `${r.method} ${decodeURIComponent(new URL(r.url).pathname).replace(/^\/__stagecraft\/mock\/([^/]+)/, '$1').replace(/contexts\/[^/?]+/, 'contexts/…').replace(/(eval\/[^/]+)\/[^/?]+/, '$1/…')}`);
    expect(paths).toEqual(expect.arrayContaining([
      'GET https://app.launchdarkly.com/sdk/evalx/ref-flags-client-side-id/contexts/…', // v3 polling
      'GET https://clientsdk.launchdarkly.com/sdk/evalx/ref-flags-client-side-id/contexts/…', // v4 polling
      'GET https://clientstream.launchdarkly.com/eval/ref-flags-client-side-id/…', // stream (answered 204)
    ]));
    // A failed stream backs off; it does not hammer the proxy.
    await page.waitForTimeout(3000);
    const streams = requests.filter((r) => r.url.includes(encodeURIComponent('https://clientstream.launchdarkly.com'))).length;
    expect(streams).toBeLessThan(12);

    // The value survives a reload (it is in the session and in the URL).
    await page.reload({ waitUntil: 'networkidle' });
    await expect.poll(() => text(page, 'ld-banner')).toBe('Happy holidays: free shipping');
    await expect.poll(() => text(page, 'ld4-header')).toBe('Compact header');
    await assertNoVendorCalls();
    await ctx.close();
  });

  it('(v1) GrowthBook and Unleash: the panel flag changes the UI live, with no vendor call', async () => {
    const ctx = await newContext();
    const page = await open(ctx);
    await expect.poll(() => text(page, 'gb-pricing')).toBe('Billed monthly: $10/mo');
    await expect.poll(() => text(page, 'unleash-beta')).toBe('Beta features off');
    await panel(page).getByLabel('gb-annual-pricing').check();
    await expect.poll(() => text(page, 'gb-pricing')).toBe('Billed annually: $96/yr');
    await panel(page).getByLabel('unleash-beta-badge').check();
    await expect.poll(() => text(page, 'unleash-beta')).toBe('Beta features on');
    await assertNoVendorCalls();
    await ctx.close();
  });

  it('per viewer: two sessions see different flag values at the same time', async () => {
    const ctx = await newContext();
    const a = await open(ctx, '/');
    const b = await open(ctx, '/?__sc_session=fork');
    await panel(b).getByLabel('of-new-checkout').check();
    await panel(b).getByLabel('ld-banner').selectOption('"sale"');
    await expect.poll(() => text(b, 'of-checkout')).toBe('New one-page checkout');
    await expect.poll(() => text(b, 'ld-banner')).toBe('Spring sale: 20% off');
    await a.reload({ waitUntil: 'networkidle' });
    await expect.poll(() => text(a, 'ld-banner')).toBe('No promotion');
    expect(await text(a, 'of-checkout')).toBe('Classic three-step checkout');
    await assertNoVendorCalls();
    await ctx.close();
  });
});
