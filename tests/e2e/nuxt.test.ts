import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { devServerEnv, startServer, type Engine, type StagecraftServer } from '@stagecraft/server';
import { REPO, fixture, freePort, until } from '../helpers.ts';

// Nuxt 4: `nuxi dev` forks a child process, and Nitro renders pages in a worker thread of that
// child. The Node preload (NODE_OPTIONS --import) must reach that worker for SSR to hit the mocks.
const APP = join(REPO, 'examples/ref-nuxt');
let nuxt: ChildProcess;
let server: StagecraftServer;
let engine: Engine;
let base: string;
let browser: Browser;
const nuxtLog: string[] = [];

beforeAll(async () => {
  // Stagecraft files in a temp copy so the test cannot change the example.
  const fx = fixture('nuxt', APP);
  const port = await freePort();
  const s = await startServer(fx.config, { port: 0, devUrl: `http://localhost:${port}`, watch: false, log: () => {} });
  ({ server, engine } = s);
  base = s.url;
  const env = devServerEnv({ proxyUrl: base, apiOrigins: engine.config.apiOrigins, extra: { NUXT_TELEMETRY_DISABLED: '1' } });
  nuxt = spawn('npx', ['nuxt', 'dev', '--port', String(port)], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  nuxt.stdout!.on('data', (d) => nuxtLog.push(String(d)));
  nuxt.stderr!.on('data', (d) => nuxtLog.push(String(d)));
  await until(async () => (await fetch(`http://localhost:${port}/`, { headers: { accept: 'text/html' } }).catch(() => null))?.ok, 90_000, 500);
  browser = await chromium.launch();
  // Warm up: Vite optimizes client deps on first use and may reload the page then.
  const p = await browser.newPage();
  for (const path of ['/', '/settings', '/']) await p.goto(base + path, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);
  await p.close();
}, 150_000);

afterAll(async () => {
  await browser?.close();
  if (nuxt?.pid) process.kill(-nuxt.pid, 'SIGTERM');
  await server?.close();
});

const warnings: string[] = [];
async function open(path: string): Promise<Page> {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => {
    if (/hydration/i.test(m.text())) warnings.push(m.text());
  });
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.locator('stagecraft-panel').waitFor({ state: 'attached' });
  return page;
}
// Generous: other suites may be loading the machine; a state switch is a round trip plus a refetch.
const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 15_000 });
const panel = (p: Page) => p.locator('stagecraft-panel');
const text = (html: string, id: string) => new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html)?.[1];

describe('Nuxt 4: server-side useFetch / $fetch on mock data (FR-501 SSR)', () => {
  it('server-renders data from the mock DB, never the real API', async () => {
    engine.sessions.clear();
    // The HTML itself, before any client JS runs.
    const html = await (await fetch(base + '/', { headers: { accept: 'text/html' } })).text();
    expect(text(html, 'account-name')).toBe('Lumen Outdoor Gear');
    expect(text(html, 'me')).toBe('Ines Admin · admin');
    expect(html).toContain('Tent zipper broke on day one');
    const settings = await (await fetch(base + '/settings', { headers: { accept: 'text/html' } })).text();
    expect(text(settings, 'settings-role')).toBe('You can change the plan for Lumen Outdoor Gear.');
    // A session's state reaches the server render (session header → AsyncLocalStorage → fetch).
    const H = { 'content-type': 'application/json', 'x-stagecraft-session': 'ssr-probe' };
    expect((await fetch(`${base}/__stagecraft/api/session`, { method: 'PATCH', headers: H, body: JSON.stringify({ persona: 'agent', states: { account: 'suspended' } }) })).ok).toBe(true);
    const other = await (await fetch(base + '/', { headers: { accept: 'text/html', 'x-stagecraft-session': 'ssr-probe' } })).text();
    expect(text(other, 'me')).toBe('Theo Agent · agent');
    expect(text(other, 'banner')).toMatch(/suspended/);
    expect(nuxtLog.join('')).not.toMatch(/orbit-support\.example.*(ENOTFOUND|fetch failed)|not a declared API origin/);
  });

  it('switching persona and state re-renders server data (refreshNuxtData) with no full reload', async () => {
    engine.sessions.clear();
    const page = await open('/');
    expect(await page.getByTestId('me').textContent()).toBe('Ines Admin · admin');
    await page.evaluate(() => ((window as any).__noReload = true));
    await panel(page).getByLabel('Persona').selectOption('agent');
    await panel(page).getByRole('combobox', { name: 'Account' }).selectOption('past_due');
    await poll(() => page.getByTestId('me').textContent()).toBe('Theo Agent · agent');
    await poll(() => page.getByTestId('banner').textContent()).toMatch(/past due/);
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
    await page.close();
  });

  it('flags and variants switch live, and a selected variant hydrates without a mismatch', async () => {
    engine.sessions.clear();
    warnings.length = 0;
    const page = await open('/');
    await page.getByTestId('tickets').waitFor();
    await panel(page).getByRole('combobox', { name: 'ticket-list-layout' }).selectOption('cards');
    await page.getByTestId('ticket-cards').waitFor();
    await panel(page).getByLabel('priority-badges').check();
    await poll(() => page.locator('[data-testid=ticket-cards] .pill').count()).toBe(2);
    // Reload: the server renders the default option (it cannot see the variant); the client
    // hydrates the same markup (ssr mode), then switches. No hydration mismatch.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('ticket-cards').waitFor();
    expect(warnings).toEqual([]);
    await page.close();
  });

  it('a client-side write is visible to the server render', async () => {
    engine.sessions.clear();
    const page = await open('/');
    // The table's buttons sit under the panel (bottom right): dock the panel left, as a viewer would.
    await panel(page).getByRole('button', { name: 'Move panel to the left side' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    await poll(() => page.getByRole('button', { name: 'Close' }).count()).toBe(0);
    expect((engine.getSession().dbRef.db as any).tickets[0].status).toBe('closed');
    const html = await (await fetch(base + '/', { headers: { accept: 'text/html' } })).text();
    expect(html).not.toMatch(/>open</);
    await page.close();
  });

  it('forked sessions stay isolated on the server, including client navigation', async () => {
    engine.sessions.clear();
    const main = await open('/');
    await panel(main).getByRole('combobox', { name: 'Tickets' }).selectOption('none');
    await main.getByTestId('empty').waitFor({ timeout: 15000 });
    const fork = await open('/?__sc_session=fork&sc_scenario=suspended-agent');
    expect(await fork.getByTestId('me').textContent()).toBe('Theo Agent · agent');
    expect(await fork.getByTestId('banner').textContent()).toMatch(/suspended/);
    expect(await fork.getByTestId('tickets').textContent()).toContain('Tent zipper');
    // Client-side navigation in the fork: data loads in the browser with the fork's session.
    await fork.getByRole('link', { name: 'Settings' }).click();
    await poll(() => fork.getByTestId('settings-role').textContent()).toBe('Only admins can change the plan.');
    expect(new URL(fork.url()).searchParams.get('__sc_session')).toBeTruthy();
    // A full server render of the fork's URL keeps the fork's session too.
    await fork.reload({ waitUntil: 'networkidle' });
    expect(await fork.getByTestId('settings-role').textContent()).toBe('Only admins can change the plan.');
    // Main is unchanged.
    await main.reload({ waitUntil: 'networkidle' });
    expect(await main.getByTestId('me').textContent()).toBe('Ines Admin · admin');
    await main.getByTestId('empty').waitFor();
    await main.close();
    await fork.close();
  });
});
