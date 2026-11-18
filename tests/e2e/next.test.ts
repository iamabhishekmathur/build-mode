import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { devServerEnv, startServer, type Engine, type StagecraftServer } from '@stagecraft/server';
import { REPO, freePort, until } from '../helpers.ts';
import { cpSync, mkdirSync } from 'node:fs';

const APP = join(REPO, 'examples/ref-next-app');
let next: ChildProcess;
let server: StagecraftServer;
let engine: Engine;
let base: string;
let browser: Browser;
const nextLog: string[] = [];

beforeAll(async () => {
  // Stagecraft files in a temp copy so the test cannot change the example.
  const fx = join(REPO, 'tests/.tmp', `next-${Date.now()}`);
  mkdirSync(fx, { recursive: true });
  cpSync(join(APP, 'stagecraft'), join(fx, 'stagecraft'), { recursive: true });
  cpSync(join(APP, 'stagecraft.config.ts'), join(fx, 'stagecraft.config.ts'));
  const port = await freePort();
  const s = await startServer(join(fx, 'stagecraft.config.ts'), { port: 0, devUrl: `http://localhost:${port}`, watch: false, log: () => {} });
  ({ server, engine } = s);
  base = s.url;
  next = spawn('npx', ['next', 'dev', '-p', String(port)], { cwd: APP, env: devServerEnv({ proxyUrl: base, apiOrigins: engine.config.apiOrigins }), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  next.stdout!.on('data', (d) => nextLog.push(String(d)));
  next.stderr!.on('data', (d) => nextLog.push(String(d)));
  await until(async () => (await fetch(`http://localhost:${port}/`, { headers: { accept: 'text/html' } }).catch(() => null))?.ok, 90_000, 500);
  browser = await chromium.launch();
  // Warm up: Next compiles each route and client chunk on first use, and may reload the page then.
  const p = await browser.newPage();
  for (const path of ['/', '/settings']) await p.goto(base + path, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);
  await p.close();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (next?.pid) process.kill(-next.pid, 'SIGTERM');
  await server?.close();
});

async function open(path: string): Promise<Page> {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(base + path, { waitUntil: 'networkidle' });
  return page;
}
const panel = (p: Page) => p.locator('stagecraft-panel');

describe('Next.js App Router: server components on mock data (FR-501 SSR)', () => {
  it('renders server-fetched data from the mock DB, never the real API', async () => {
    const page = await open('/');
    expect(await page.getByTestId('account-name').textContent()).toBe('Fernwood Studio');
    expect(await page.getByTestId('me').textContent()).toBe('Olu Owner · owner');
    expect(nextLog.join('')).not.toMatch(/acme-billing\.example.*(ENOTFOUND|fetch failed)/);
    await page.close();
  });

  it('switching persona and state re-renders server components with no full reload', async () => {
    const page = await open('/');
    await page.evaluate(() => ((window as any).__noReload = true));
    await panel(page).getByLabel('Persona').selectOption('viewer');
    await panel(page).getByRole('combobox', { name: 'Account' }).selectOption('past_due');
    await expect.poll(() => page.getByTestId('me').textContent(), { timeout: 15000 }).toBe('Vic Viewer · viewer');
    await expect.poll(() => page.getByTestId('banner').textContent()).toMatch(/payment method failed/);
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
    // Viewer: no pay buttons (decided on the server from the mock persona).
    expect(await page.getByRole('button', { name: 'Mark paid' }).count()).toBe(0);
    await page.close();
  });

  it('a client-side write is visible to server components after refresh', async () => {
    engine.sessions.clear();
    const page = await open('/');
    await page.getByRole('button', { name: 'Mark paid' }).click();
    await expect.poll(() => page.getByTestId('invoices').textContent(), { timeout: 15000 }).not.toMatch(/open/);
    expect((engine.getSession().dbRef.db as any).invoices[0].status).toBe('paid');
    await page.close();
  });

  it('forked sessions stay isolated on the server (share links, compare frames)', async () => {
    engine.sessions.clear();
    const main = await open('/');
    await panel(main).getByRole('combobox', { name: 'Invoices' }).selectOption('none');
    await main.getByTestId('empty').waitFor({ timeout: 15000 });
    const fork = await open('/?__sc_session=fork&sc_scenario=suspended-viewer');
    expect(await fork.getByTestId('me').textContent()).toBe('Vic Viewer · viewer');
    expect(await fork.getByTestId('banner').textContent()).toMatch(/suspended/);
    expect(await fork.getByTestId('invoices').textContent()).toMatch(/overdue/);
    // Client-side navigation in the fork (RSC request) keeps the fork's session.
    await fork.getByRole('link', { name: 'Settings' }).click();
    await expect.poll(() => fork.getByTestId('settings-role').textContent(), { timeout: 15000 }).toBe('Only the account owner can change billing.');
    // Main is unchanged.
    await main.reload({ waitUntil: 'networkidle' });
    expect(await main.getByTestId('me').textContent()).toBe('Olu Owner · owner');
    await main.getByTestId('empty').waitFor();
    await main.close();
    await fork.close();
  });
});
