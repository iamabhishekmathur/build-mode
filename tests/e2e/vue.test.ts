import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { startServer, type Engine, type StagecraftServer } from '@stagecraft/server';
import { REPO, fixture, freePort } from '../helpers.ts';

const APP = join(REPO, 'examples/ref-vue-vite');
let vite: ViteDevServer;
let server: StagecraftServer;
let engine: Engine;
let base: string;
let browser: Browser;

beforeAll(async () => {
  const { createServer } = await import('vite');
  const port = await freePort();
  vite = await createServer({ root: APP, configFile: join(APP, 'vite.config.ts'), logLevel: 'silent', server: { port, strictPort: true } });
  await vite.listen();
  // Stagecraft files in a temp copy so the test cannot change the example.
  const fx = fixture('vue', APP);
  const s = await startServer(fx.config, { port: 0, devUrl: `http://localhost:${port}`, watch: false, log: () => {} });
  ({ server, engine } = s);
  base = s.url;
  browser = await chromium.launch();
  // Warm up Vite's dependency optimizer so later page loads do not reload mid-test.
  const p = await browser.newPage();
  for (const path of ['/', '/projects', '/settings']) await p.goto(base + path, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.close();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await vite?.close();
});

beforeEach(() => engine.sessions.clear());

async function open(path: string): Promise<Page> {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.locator('stagecraft-panel').waitFor({ state: 'attached' });
  return page;
}
// Generous: other suites may be loading the machine; a state switch is a round trip plus a refetch.
const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 15_000 });
const panel = (page: Page) => page.locator('stagecraft-panel');
const mark = (page: Page) => page.evaluate(() => ((window as any).__noReload = true));
const notReloaded = (page: Page) => page.evaluate(() => (window as any).__noReload === true);

describe('Vue 3 + Vite + Pinia (@stagecraft/vue)', () => {
  it('registers the vue adapter and switches persona and state with no page reload', async () => {
    const page = await open('/');
    await poll(() => page.getByTestId('me').textContent()).toBe('Olivia Ortiz · owner');
    await mark(page);
    await panel(page).getByLabel('Persona').selectOption('member');
    await poll(() => page.getByTestId('me').textContent()).toBe('Milo Meyer · member');
    await panel(page).getByLabel('Workspace').selectOption('trial_expired');
    await poll(() => page.getByTestId('workspace-banner').textContent()).toMatch(/trial has ended/);
    await poll(() => page.getByTestId('plan').textContent()).toMatch(/^Trial plan/);
    // Cross-origin API data (projects) follows its state too.
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByTestId('projects-list').waitFor();
    await panel(page).getByLabel('Projects').selectOption('none');
    await page.getByTestId('projects-empty').waitFor();
    expect(await notReloaded(page)).toBe(true);
    expect(new URL(page.url()).searchParams.get('__sc')).toBeTruthy();
    await page.close();
  });

  it('switches a slot-based <Variant> with no reload', async () => {
    const page = await open('/projects');
    await page.getByTestId('projects-list').waitFor();
    await mark(page);
    await panel(page).getByRole('combobox', { name: 'project-list-layout' }).selectOption('grid');
    await page.getByTestId('projects-grid').waitFor();
    expect(await page.getByTestId('projects-list').count()).toBe(0);
    expect(await notReloaded(page)).toBe(true);
    await page.close();
  });

  it('a flag changes the UI (useFlag)', async () => {
    const page = await open('/projects');
    await page.getByTestId('projects-list').waitFor();
    expect(await page.locator('.pill').count()).toBe(0);
    await panel(page).getByLabel('project-health').check();
    await poll(() => page.locator('[data-testid=projects-list] .pill').count()).toBe(2);
    await page.close();
  });

  it('mock DB writes persist across persona switches and reloads (same-origin and cross-origin)', async () => {
    const page = await open('/settings');
    await panel(page).getByLabel('Persona').selectOption('member');
    await poll(() => page.getByTestId('me').textContent()).toBe('Milo Meyer · member');
    await page.getByLabel('Status message').fill('On holiday until Monday');
    await page.getByRole('button', { name: 'Save status' }).click();
    await poll(() => page.getByTestId('current-status').textContent()).toBe('On holiday until Monday');
    await panel(page).getByLabel('Persona').selectOption('owner');
    await poll(() => page.getByTestId('current-status').textContent()).toBe('No status set.');
    await panel(page).getByLabel('Persona').selectOption('member');
    await poll(() => page.getByTestId('current-status').textContent()).toBe('On holiday until Monday');
    await page.reload({ waitUntil: 'networkidle' });
    await poll(() => page.getByTestId('current-status').textContent()).toBe('On holiday until Monday');
    // A write to the cross-origin API, as the owner.
    await panel(page).getByLabel('Persona').selectOption('owner');
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByPlaceholder('Project name').fill('Q1 launch');
    await page.getByRole('button', { name: 'Create project' }).click();
    await poll(() => page.getByTestId('projects-list').textContent()).toContain('Q1 launch');
    expect((engine.getSession().dbRef.db as any).projects.map((p: any) => p.name)).toContain('Q1 launch');
    await page.close();
  });

  it('forked sessions stay isolated (share links, compare frames)', async () => {
    const main = await open('/projects');
    await panel(main).getByLabel('Projects').selectOption('none');
    await main.getByTestId('projects-empty').waitFor();
    const fork = await open('/projects?__sc_session=fork&sc_scenario=trial-expired-member');
    await poll(() => fork.getByTestId('me').textContent()).toBe('Milo Meyer · member');
    await poll(() => fork.locator('[data-testid=projects-list] li').count()).toBe(12);
    expect(await fork.getByTestId('workspace-banner').textContent()).toMatch(/trial has ended/);
    // Client-side navigation in the fork keeps the fork's session.
    await fork.getByRole('link', { name: 'Settings' }).click();
    await poll(() => fork.getByText('Signed in as milo@fieldnote.test').count()).toBe(1);
    expect(new URL(fork.url()).searchParams.get('__sc_session')).toBeTruthy();
    // Main is unchanged.
    await main.reload({ waitUntil: 'networkidle' });
    await poll(() => main.getByTestId('me').textContent()).toBe('Olivia Ortiz · owner');
    await main.getByTestId('projects-empty').waitFor();
    expect(await main.getByTestId('workspace-banner').count()).toBe(0);
    await main.close();
    await fork.close();
  });
});
