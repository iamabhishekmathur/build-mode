import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { startServer, type Engine, type StagecraftServer } from '@stagecraft/server';
import { EXAMPLE, fixture, freePort } from '../helpers.ts';

let vite: ViteDevServer;
let server: StagecraftServer;
let engine: Engine;
let base: string;
let browser: Browser;
let fxRoot: string;

beforeAll(async () => {
  const { createServer } = await import('vite');
  const port = await freePort();
  vite = await createServer({ root: EXAMPLE, configFile: join(EXAMPLE, 'vite.config.ts'), logLevel: 'silent', server: { port, strictPort: true } });
  await vite.listen();
  const fx = fixture('e2e');
  fxRoot = fx.root;
  const s = await startServer(fx.config, { port: 0, devUrl: `http://localhost:${port}`, watch: false, log: () => {}, tapeSpeed: 0.3 });
  ({ server, engine } = s);
  base = s.url;
  browser = await chromium.launch();
  // Warm up Vite's dependency optimizer so later page loads do not reload mid-test.
  const p = await browser.newPage();
  await p.goto(base + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.close();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await vite?.close();
});

beforeEach(() => {
  // Fresh main session per test.
  for (const s of engine.sessions.values()) engine.stopTape(s);
  engine.sessions.clear();
});

async function open(path: string, opts: { width?: number; panel?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: opts.width ?? 1280, height: 900 } });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(base + path, { waitUntil: 'networkidle' });
  if (opts.panel !== false) await page.locator('stagecraft-panel').waitFor({ state: 'attached' });
  return page;
}

const panel = (page: Page) => page.locator('stagecraft-panel');
const mark = (page: Page) => page.evaluate(() => ((window as any).__noReload = true));
const notReloaded = (page: Page) => page.evaluate(() => (window as any).__noReload === true);

describe('J-3: states, personas, flags and variants', () => {
  it('switches persona and state in the panel with no page reload', async () => {
    const page = await open('/');
    await expect.poll(() => page.getByTestId('me').textContent()).toContain('Ada Okafor');
    await mark(page);
    await panel(page).getByLabel('Persona').selectOption('employee');
    await expect.poll(() => page.getByTestId('me').textContent()).toContain('Eli Brandt');
    await panel(page).getByLabel('Account').selectOption('frozen');
    await expect.poll(() => page.getByTestId('account-banner').textContent()).toMatch(/account is frozen/);
    expect(await notReloaded(page)).toBe(true);
    expect(new URL(page.url()).searchParams.get('__sc')).toBeTruthy();
    await page.close();
  });

  it('FR-503: onboarding progress survives persona switches and reloads', async () => {
    const page = await open('/onboarding');
    await panel(page).getByLabel('Persona').selectOption('employee');
    await expect.poll(() => page.getByTestId('onboarding-status').textContent()).toBe('Step 2 of 4: Add a bank account');
    await page.getByRole('button', { name: 'Complete step 2' }).click();
    await expect.poll(() => page.getByTestId('onboarding-status').textContent()).toBe('Step 3 of 4: Invite your team');
    await panel(page).getByLabel('Persona').selectOption('admin');
    await expect.poll(() => page.getByTestId('onboarding-status').textContent()).toBe('Onboarding complete.');
    await panel(page).getByLabel('Persona').selectOption('employee');
    await expect.poll(() => page.getByTestId('onboarding-status').textContent()).toBe('Step 3 of 4: Invite your team');
    await page.reload({ waitUntil: 'networkidle' });
    await expect.poll(() => page.getByTestId('onboarding-status').textContent()).toBe('Step 3 of 4: Invite your team');
    await page.close();
  });

  it('FR-404: switches variants with no rebuild or reload, and compares them side by side', async () => {
    const page = await open('/settings/agents');
    await page.getByTestId('agents-table').waitFor();
    await mark(page);
    await panel(page).getByRole('combobox', { name: 'agent-list-layout' }).selectOption('cards');
    await page.getByTestId('agents-cards').waitFor();
    expect(await notReloaded(page)).toBe(true);
    const [popup] = await Promise.all([page.waitForEvent('popup'), panel(page).getByRole('button', { name: 'Compare agent-list-layout side by side' }).click()]);
    await popup.waitForLoadState('networkidle');
    const frames = popup.frames().filter((f) => f !== popup.mainFrame());
    expect(frames).toHaveLength(2);
    await expect.poll(async () => (await Promise.all(frames.map((f) => f.locator('[data-testid^=agents-]').first().getAttribute('data-testid')))).sort()).toEqual(['agents-cards', 'agents-table']);
    // Each frame is its own forked session, with no panel.
    expect(await frames[0]!.locator('stagecraft-panel').count()).toBe(0);
    await popup.close();
    await page.close();
  });

  it('flags change the UI', async () => {
    const page = await open('/');
    expect(await page.locator('.nav--top').count()).toBe(1);
    await panel(page).getByLabel('new-nav').check();
    await page.locator('.nav--side').waitFor();
    await panel(page).getByLabel('limit-display').selectOption('"text"');
    await expect.poll(() => page.locator('[role=meter]').count()).toBe(0);
    await page.close();
  });
});

describe('scenarios and links', () => {
  it('FR-601/603: loads a scenario (with extends) and saves a new one to the repo', async () => {
    const page = await open('/');
    await panel(page).getByLabel('Load').selectOption('Bill pay company – frozen');
    await expect.poll(() => page.getByTestId('account-banner').textContent()).toMatch(/frozen/);
    await page.getByRole('link', { name: 'Agent controls' }).click();
    await expect.poll(() => page.locator('[data-testid=agents-table] tbody tr').count()).toBe(14);
    await panel(page).getByLabel('New scenario name').fill('Frozen with many agents');
    await panel(page).getByRole('button', { name: 'Save' }).click();
    const file = join(fxRoot, 'stagecraft/scenarios/frozen-with-many-agents.json');
    await expect.poll(() => existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ states: { account: 'frozen', agents: 'many', approvals: 'pending' }, url: '/settings/agents' });
    await page.close();
  });

  it('FR-806: the address bar URL reproduces the view in a new browser', async () => {
    const page = await open('/payments');
    await panel(page).getByLabel('Persona').selectOption('employee');
    await panel(page).getByLabel('Approvals').selectOption('pending');
    await page.getByTestId('approvals').waitFor();
    const url = page.url();
    await page.close();
    engine.sessions.clear(); // a different machine: fresh proxy state
    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await p2.goto(url, { waitUntil: 'networkidle' });
    await expect.poll(() => p2.getByTestId('me').textContent()).toContain('Eli Brandt');
    await expect.poll(() => p2.getByTestId('approvals').textContent()).toContain('Waiting for an admin');
    await ctx.close();
  });

  it('FR-409: injects a 500 from the panel and shows the app error state', async () => {
    const page = await open('/payments');
    await panel(page).getByRole('combobox', { name: 'Endpoint' }).selectOption('GET /api/payments');
    await panel(page).getByRole('combobox', { name: 'Fault', exact: true }).selectOption('500 error');
    await panel(page).getByRole('button', { name: 'Add' }).click();
    await expect.poll(() => page.getByTestId('payments-error').count()).toBe(1);
    await page.close();
  });

  it('FR-805: hidden mode adds zero pixels', async () => {
    const page = await open('/payments');
    await page.getByTestId('payments').waitFor();
    await panel(page).getByRole('button', { name: /Hide panel/ }).click();
    const hidden = await page.screenshot();
    const clean = await open('/payments?sc_panel=0', { panel: false });
    await clean.getByTestId('payments').waitFor();
    expect(Buffer.compare(hidden, await clean.screenshot())).toBe(0);
    await page.keyboard.press('Alt+Shift+S');
    await panel(page).getByLabel('Persona').waitFor();
    await page.close();
    await clean.close();
  });

  it('agents can navigate open tabs (preview_navigate)', async () => {
    const page = await open('/');
    await fetch(`${base}/__stagecraft/api/navigate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: '/payments' }) });
    await expect.poll(() => new URL(page.url()).pathname).toBe('/payments');
    await page.getByTestId('payments').waitFor();
    await page.close();
  });
});

describe('J-7: tapes', () => {
  it('plays the vendor payment tape: stream, timeout, retry, approve, branch', async () => {
    const page = await open('/');
    await panel(page).getByRole('combobox', { name: 'Tape', exact: true }).selectOption('vendor-payment-approval');
    // The app's chat drawer is on the right, under the panel: dock the panel left, as a viewer would.
    await panel(page).getByRole('button', { name: 'Move panel to the left side' }).click();
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const chat = page.getByTestId('assistant');
    await chat.getByText("Sure. I'll set up a $4,200 payment to Acme Tools.").waitFor();
    await page.getByTestId('assistant-timeout').waitFor();
    await chat.getByRole('button', { name: 'Retry' }).click();
    await chat.getByText('A request timed out and was retried.').waitFor();
    const action = page.getByTestId('pending-action');
    await action.waitFor();
    await expect.poll(async () => (await panel(page).getByText(/Waiting for an action in the UI/).count()) > 0).toBe(true);
    const liveChat = await chat.locator('.chat__body').innerText();
    await action.getByRole('button', { name: 'Approve' }).click();
    await chat.getByText('Approved and scheduled. Acme Tools will be paid today.').waitFor();
    await expect.poll(() => action.textContent()).toContain('approved');
    await page.getByRole('link', { name: 'Payments' }).click();
    await expect.poll(() => page.getByTestId('payments').textContent()).toMatch(/Acme Tools.*approved/);

    // FR-704: a deep link to the step shows the same chat, in a forked session.
    const deep = await open('/?__sc_session=fork&sc_tape=vendor-payment-approval&sc_step=9');
    await panel(deep).getByRole('button', { name: 'Move panel to the left side' }).click();
    await deep.getByRole('button', { name: 'Assistant', exact: true }).click();
    await deep.getByTestId('pending-action').getByRole('button', { name: 'Approve' }).waitFor();
    expect(await deep.getByTestId('assistant').locator('.chat__body').innerText()).toBe(liveChat);
    // FR-705/706: the deep-linked viewer rejects; the tape follows the other branch.
    await deep.getByTestId('pending-action').getByRole('button', { name: 'Reject' }).click();
    await deep.getByText('OK. I cancelled the payment and told Eli why.').waitFor();
    await page.close();
    await deep.close();
  });

  it('FR-707: shows a partial stream and the error UI', async () => {
    const page = await open('/?sc_tape=assistant-stream-error');
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await page.getByTestId('assistant-error').waitFor();
    // cutAt: 70 stops the stream mid-word; the UI marks it as partial.
    expect(await page.getByTestId('assistant-message').innerText()).toMatch(/^Card spend went up 18% mainly because of three new software subscripti\s*…$/);
    await page.close();
  });

  it('FR-709: timeline step and scrub work from the keyboard', async () => {
    const page = await open('/');
    await panel(page).getByRole('combobox', { name: 'Tape', exact: true }).selectOption('assistant-stream-error');
    await panel(page).getByRole('button', { name: 'Pause' }).waitFor();
    await panel(page).getByRole('button', { name: /Restart tape/ }).click();
    await panel(page).getByRole('button', { name: 'Play' }).waitFor();
    await expect.poll(() => panel(page).getByText(/Step 0\/3/).count()).toBe(1);
    await panel(page).getByRole('button', { name: 'Step forward' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => panel(page).getByText(/Step 1\/3/).count()).toBe(1);
    const scrub = panel(page).getByLabel(/Tape position/);
    await scrub.focus();
    await page.keyboard.press('End');
    await expect.poll(() => panel(page).getByText(/Step 3\/3/).count()).toBe(1);
    await page.close();
  });
});
