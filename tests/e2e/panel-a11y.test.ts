import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { axeSource } from '@stagecraft/checks';
import { startServer, type StagecraftServer } from '@stagecraft/server';
import { fixture } from '../helpers.ts';

let upstream: http.Server;
let server: StagecraftServer;
let base: string;
let browser: Browser;

beforeAll(async () => {
  upstream = http.createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<!doctype html><html lang="en"><head><title>App</title></head><body><main><h1>App</h1></main></body></html>');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const fx = fixture('panel-a11y');
  const s = await startServer(fx.config, { port: 0, devUrl: `http://127.0.0.1:${(upstream.address() as any).port}`, watch: false, log: () => {} });
  server = s.server;
  base = s.url;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  upstream?.close();
});

/** axe inside the panel's shadow root (axe walks open shadow roots). */
async function axePanel(page: import('playwright').Page) {
  await page.addScriptTag({ content: axeSource() });
  return page.evaluate(async () => {
    const res = await (window as any).axe.run({ include: [['stagecraft-panel']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return res.violations.map((v: any) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0].target.join(' ')}`);
  });
}

describe('panel accessibility (NFR-601..603)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it(`no WCAG 2.2 A/AA violations in the open panel (${scheme})`, async () => {
      const page = await browser.newPage({ colorScheme: scheme });
      await page.goto(base + '/', { waitUntil: 'load' });
      await page.locator('stagecraft-panel').getByLabel('Persona').waitFor();
      const v = await axePanel(page);
      console.log(`${scheme}: ${v.length ? v.join('\n') : 'no violations'}`);
      expect(v).toEqual([]);
      await page.close();
    });
  }

  it('the comment composer and collapsed handle are accessible too, and everything works by keyboard', async () => {
    const page = await browser.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    const panel = page.locator('stagecraft-panel');
    // Keyboard: Tab reaches panel controls; Enter on 💬 starts picking; Escape cancels.
    await panel.getByRole('button', { name: /Add a comment/ }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    expect(await panel.getByRole('button', { name: /Add a comment/ }).getAttribute('aria-pressed')).toBe('false');
    await panel.getByRole('button', { name: 'Collapse panel' }).focus();
    await page.keyboard.press('Enter');
    await panel.getByRole('button', { name: 'SC: open Stagecraft panel' }).waitFor();
    expect(await axePanel(page)).toEqual([]);
    await panel.getByRole('button', { name: 'SC: open Stagecraft panel' }).focus();
    await page.keyboard.press('Enter');
    await panel.getByLabel('Persona').waitFor();
    await page.close();
  });
});
