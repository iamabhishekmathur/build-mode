import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { startServer, type Engine, type StagecraftServer } from '@stagecraft/server';
import { EXAMPLE, fixture, freePort } from '../helpers.ts';

let vite: ViteDevServer;
let server: StagecraftServer;
let engine: Engine;
let base: string;
let browser: Browser;

beforeAll(async () => {
  const { createServer } = await import('vite');
  const port = await freePort();
  vite = await createServer({ root: EXAMPLE, configFile: join(EXAMPLE, 'vite.config.ts'), logLevel: 'silent', server: { port, strictPort: true } });
  await vite.listen();
  const fx = fixture('fb-e2e');
  const s = await startServer(fx.config, { port: 0, devUrl: `http://localhost:${port}`, watch: false, log: () => {} });
  ({ server, engine } = s);
  base = s.url;
  browser = await chromium.launch();
  const p = await browser.newPage();
  await p.goto(base + '/payments', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.close();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await vite?.close();
});

const panel = (p: Page) => p.locator('stagecraft-panel');
const pins = (p: Page) => p.locator('stagecraft-overlay .pin');
const agentApi = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/__stagecraft/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-stagecraft-actor': 'agent' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

describe('feedback pins and the agent loop (J-4)', () => {
  it('picks an element with its React source, swallows the click, pins it, and keeps the pin anchored', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base + '/payments', { waitUntil: 'networkidle' });
    await panel(page).getByRole('combobox', { name: 'Approvals' }).selectOption('pending');
    const approve = page.getByRole('button', { name: 'Approve' }).first();
    await approve.waitFor();
    await panel(page).getByRole('button', { name: /Add a comment/ }).click();
    // Hover shows a tooltip with the source; click picks instead of approving.
    await approve.hover();
    await expect.poll(() => page.locator('stagecraft-overlay .tip').textContent()).toMatch(/button "Approve".*Payments\.tsx/);
    await approve.click();
    const composer = panel(page).getByRole('textbox', { name: 'Comment' });
    await composer.waitFor();
    expect(await panel(page).getByText(/On <Payments> button "Approve" · pages\/Payments\.tsx:\d+/).count()).toBe(1);
    // The app never saw the click: the payment is still pending.
    expect((engine.getSession().dbRef.db as any).payments.find((x: any) => x.id === 'p3').status).toBe('pending_approval');
    await composer.fill('This should say Disconnect');
    await panel(page).getByRole('textbox', { name: 'Your name' }).fill('Priya');
    await panel(page).getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => pins(page).count()).toBe(1);
    const [stored] = await (await fetch(`${base}/__stagecraft/api/feedback`)).json();
    expect(stored).toMatchObject({ author: 'Priya', source: { framework: 'react', component: 'Payments' }, state: { states: { approvals: 'pending' } } });
    expect(stored.source.file).toMatch(/\/src\/pages\/Payments\.tsx$/);
    // Layout shift: a banner appears above. The pin follows the button.
    const before = (await pins(page).first().boundingBox())!.y;
    await panel(page).getByRole('combobox', { name: 'Account' }).selectOption('frozen');
    await page.getByTestId('account-banner').waitFor();
    await expect.poll(async () => (await pins(page).first().boundingBox())!.y, { timeout: 5000 }).toBeGreaterThan(before + 20);
    const btn = (await page.getByRole('button', { name: 'Approve' }).first().boundingBox())!;
    const pin = (await pins(page).first().boundingBox())!;
    expect(Math.abs(pin.y + 12 - btn.y)).toBeLessThan(6);
    await page.close();
  }, 60000);

  it('draws a region comment, sends to the agent, shows the reply, and the person resolves', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base + '/payments', { waitUntil: 'networkidle' });
    await panel(page).getByRole('button', { name: /Add a comment/ }).click();
    await page.mouse.move(40, 200);
    await page.mouse.down();
    await page.mouse.move(300, 320, { steps: 5 });
    await page.mouse.up();
    await panel(page).getByRole('textbox', { name: 'Comment' }).fill('Too much space here');
    await panel(page).getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => pins(page).count()).toBe(2);
    const all = await (await fetch(`${base}/__stagecraft/api/feedback`)).json();
    const region = all.find((c: any) => c.text === 'Too much space here');
    expect(region.anchor).toMatchObject({ kind: 'region', box: { width: 260, height: 120 } });

    await panel(page).getByRole('button', { name: 'Send 2 open comments to agent' }).click();
    await panel(page).getByText('Handle the Stagecraft feedback').waitFor();
    const sent = await agentApi('GET', '/feedback?status=sent');
    expect(sent).toHaveLength(2);
    await agentApi('POST', `/feedback/${region.id}/reply`, { text: 'Reduced the gap to 16px.' });
    await panel(page).getByText('Reduced the gap to 16px.').waitFor({ timeout: 30000 });
    await expect.poll(() => panel(page).getByRole('link', { name: 'after' }).count()).toBeGreaterThan(0);
    // Resolve the region comment: its pin goes away.
    await panel(page).locator(`[data-comment="${region.id}"]`).getByRole('button', { name: 'Resolve' }).click();
    await expect.poll(() => pins(page).count()).toBe(1);
    // Hidden panel → no pins either (zero pixels, FR-805).
    await panel(page).getByRole('button', { name: /Hide panel/ }).click();
    await expect.poll(() => pins(page).count()).toBe(0);
    await page.keyboard.press('Alt+Shift+S');
    await page.close();
  }, 90000);
});
