import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { settle } from '@stagecraft/server';

export interface Cell {
  label?: string;
  persona?: string;
  states?: Record<string, string>;
  scenario?: string;
  flags?: Record<string, unknown>;
  variants?: Record<string, string>;
  viewport?: { width: number; height: number };
  theme?: 'light' | 'dark';
}

/** Fixed time for checks: same input → same pixels (FR-1007). Scenario clocks still win. */
export const CHECK_TIME = new Date('2026-01-15T10:00:00Z');

export const VIEWPORTS = { desktop: { width: 1280, height: 800 }, tablet: { width: 768, height: 1024 }, phone: { width: 375, height: 812 } };

export function cellLabel(c: Cell): string {
  if (c.label) return c.label;
  const parts = [c.scenario, c.persona, ...Object.entries(c.states ?? {}).map(([k, v]) => `${k}=${v}`), ...Object.entries(c.variants ?? {}).map(([k, v]) => `${k}:${v}`), c.viewport ? `${c.viewport.width}w` : undefined, c.theme];
  return parts.filter(Boolean).join(' · ') || 'default';
}

/** URL that opens a cell in a fresh fork of `session` (the person's view is never changed). */
export function cellUrl(base: string, path: string, c: Cell, session = 'main', panel = false): string {
  const u = new URL(path, base);
  u.searchParams.set('__sc_session', `fork:${session}`);
  if (!panel) u.searchParams.set('sc_panel', '0');
  if (c.scenario) u.searchParams.set('sc_scenario', c.scenario);
  const sc: Record<string, unknown> = {};
  if (c.persona) sc.p = c.persona;
  if (c.states) sc.s = c.states;
  if (c.flags) sc.f = c.flags;
  if (c.variants) sc.v = c.variants;
  if (c.theme) sc.t = c.theme;
  if (Object.keys(sc).length) u.searchParams.set('__sc', Buffer.from(JSON.stringify(sc)).toString('base64url'));
  return u.href;
}

export async function launch() {
  let chromium: any;
  try {
    const mod = 'playwright';
    ({ chromium } = await import(mod));
  } catch {
    throw new Error('Playwright is not installed: run "npm i -D playwright".');
  }
  return chromium.launch();
}

/** Open a cell deterministically: fixed clock, seeded Math.random, reduced motion, no animations. */
export async function openCell(browser: any, url: string, c: Cell) {
  const page = await browser.newPage({ viewport: c.viewport ?? VIEWPORTS.desktop, reducedMotion: 'reduce', colorScheme: c.theme ?? 'light', deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(`page error: ${e.message}`));
  page.on('console', (m: any) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console error: ${m.text().slice(0, 200)}`));
  await page.clock.setFixedTime(CHECK_TIME);
  await page.addInitScript(() => {
    let s = 42;
    Math.random = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
  const resp = await page.goto(url, { waitUntil: 'load' }).catch((e: Error) => (errors.push(`navigation: ${e.message.split('\n')[0]}`), null));
  if (resp && resp.status() >= 400) errors.push(`document HTTP ${resp.status()}`);
  await settle(page, { maxMs: 8000 });
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(100);
  return { page, errors };
}

export function outDir(root: string, kind: string): string {
  const d = join(root, '.stagecraft-cache', 'checks', `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(d, { recursive: true });
  return d;
}

export function axeSource(): string {
  return readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
}

export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
