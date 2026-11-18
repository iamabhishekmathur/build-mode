import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { startServer, type Engine, type StagecraftServer } from '@stagecraft/server';
import { freePort, multiRepoFixture, REPO } from '../helpers.ts';

let fx: ReturnType<typeof multiRepoFixture>;
let vites: ViteDevServer[] = [];
let server: StagecraftServer;
let engine: Engine;
let base: string;
let browser: Browser;

beforeAll(async () => {
  const ports = { web: await freePort(), admin: await freePort() };
  fx = multiRepoFixture(ports);
  expect(spawnSync('node', [join(REPO, 'packages/cli/src/bin.ts'), 'workspace', 'link'], { cwd: fx.web }).status).toBe(0);
  const { createServer } = await import('vite');
  for (const [dir, port] of [[fx.web, ports.web], [fx.admin, ports.admin]] as const) {
    const v = await createServer({ root: dir, configFile: join(dir, 'vite.config.ts'), logLevel: 'silent', server: { port, strictPort: true } });
    await v.listen();
    vites.push(v);
  }
  const s = await startServer(join(fx.web, 'stagecraft.config.ts'), { port: 0, watch: false, log: () => {} });
  ({ server, engine } = s);
  base = s.url;
  browser = await chromium.launch();
  // Warm up both apps' dependency optimizers.
  const p = await browser.newPage();
  await p.goto(base + '/', { waitUntil: 'networkidle' });
  await p.goto(base + '/admin/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.close();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  for (const v of vites) await v.close();
});

async function open(path: string): Promise<Page> {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(base + path, { waitUntil: 'networkidle' });
  return page;
}
const badge = (p: Page) => p.locator('[data-ui=status-badge]');
const panel = (p: Page) => p.locator('stagecraft-panel');

describe('multi-repo product through one proxy', () => {
  it('serves the host app with the design system linked from its own repo', async () => {
    engine.sessions.clear();
    const page = await open('/');
    await expect.poll(() => badge(page).textContent()).toBe('Active');
    expect(await page.getByTestId('account').textContent()).toContain('Larkspur Coffee');
    await page.close();
  });

  it('the admin app (another repo, mounted at /admin) shares the session and mock DB', async () => {
    engine.sessions.clear();
    const web = await open('/');
    await panel(web).getByRole('combobox', { name: 'Account' }).selectOption('frozen');
    await expect.poll(() => badge(web).textContent()).toBe('Frozen');
    const admin = await open('/admin/');
    await expect.poll(() => admin.getByTestId('admin-account').textContent()).toContain('Frozen');
    expect(await panel(admin).count()).toBe(1); // the panel is injected into every app
    await web.close();
    await admin.close();
  });

  it('a cross-app flow in a forked session: dashboard → admin → unfreeze → dashboard', async () => {
    engine.sessions.clear();
    const page = await open('/?__sc_session=fork&sc_scenario=frozen-customer');
    await panel(page).getByLabel('Persona').selectOption('support');
    await page.getByRole('link', { name: 'Open admin' }).click();
    await page.waitForURL(/\/admin\//);
    await expect.poll(() => page.getByTestId('admin-account').textContent()).toContain('Frozen');
    await page.getByRole('button', { name: 'Unfreeze account' }).click();
    await expect.poll(() => page.getByTestId('admin-account').textContent()).toContain('Active');
    await page.getByRole('link', { name: 'Back to dashboard' }).click();
    await expect.poll(() => badge(page).textContent()).toBe('Active');
    // The write stayed in the fork: main is untouched.
    expect((engine.getSession('main').dbRef.db as any).account.status).toBe('active');
    const forks = [...engine.sessions.values()].filter((s) => s.id !== 'main');
    expect(forks).toHaveLength(1);
    expect((forks[0]!.dbRef.db as any).account.status).toBe('active');
    expect(forks[0]!.state.persona).toBe('support');
    await page.close();
  });

  it('an edit in the design-system repo shows up live in the app', async () => {
    const page = await open('/');
    await expect.poll(() => badge(page).textContent()).toBe('Active');
    const file = join(fx.ui, 'src/index.tsx');
    writeFileSync(file, readFileSync(file, 'utf8').replace("label: 'Active'", "label: 'Active ✓'"));
    await expect.poll(() => badge(page).textContent(), { timeout: 15000 }).toBe('Active ✓');
    await page.close();
  });
});
