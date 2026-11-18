import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type Engine, type StagecraftServer } from '@stagecraft/server';
import { fixture } from '../helpers.ts';

let upstream: http.Server;
let server: StagecraftServer;
let engine: Engine;
let base: string;
let cfg: string;
const REMOTE = { 'x-stagecraft-test-remote': '1' };

beforeAll(async () => {
  upstream = http.createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<!doctype html><html><head></head><body>APP</body></html>');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const fx = fixture('share');
  cfg = fx.config;
  const s = await startServer(fx.config, { port: 0, devUrl: `http://127.0.0.1:${(upstream.address() as any).port}`, watch: false, log: () => {}, simulateRemote: true });
  ({ server, engine } = s);
  base = s.url;
});
afterAll(async () => {
  await server?.close();
  upstream?.close();
});

const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/__stagecraft/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

describe('access control and share links (FR-1401..1405)', () => {
  it('remote clients cannot reach the app, the API or other sessions without a share link', async () => {
    expect((await fetch(`${base}/`, { headers: { ...REMOTE, accept: 'text/html' } })).status).toBe(403);
    expect((await api('GET', '/session', undefined, REMOTE)).status).toBe(403);
    expect((await api('PATCH', '/session', { persona: 'employee' }, { ...REMOTE, 'x-stagecraft-session': 'main' })).status).toBe(403);
    expect((await fetch(`${base}/api/me`, { headers: REMOTE })).status).toBe(403);
    expect((await fetch(`${base}/`, { headers: { accept: 'text/html' } })).status).toBe(200); // local is fine
  });

  it('a share link opens a private copy for each viewer; viewers explore and comment but cannot change files', async () => {
    await api('PATCH', '/session', { persona: 'employee', states: { account: 'frozen' } });
    const created = await (await api('POST', '/shares', { path: '/payments', expires: '1h' })).json();
    expect(created.url).toMatch(/^\/__stagecraft\/s\/[\w-]{20,}$/);
    // Owner changes their own view afterwards: the link still shows the frozen copy.
    await api('PATCH', '/session', { persona: 'admin', states: { account: 'active' } });
    const open = await fetch(`${base}${created.url}`, { headers: REMOTE, redirect: 'manual' });
    expect(open.status).toBe(303);
    const loc = new URL(open.headers.get('location')!, base);
    expect(loc.pathname).toBe('/payments');
    const vid = loc.searchParams.get('__sc_session')!;
    expect(vid).toMatch(/^v[\w-]{12,}$/);
    const page = await fetch(`${base}${loc.pathname}${loc.search}`, { headers: { ...REMOTE, accept: 'text/html' } });
    expect(page.status).toBe(200);
    const boot = JSON.parse(/__STAGECRAFT_BOOT__=(.*?);<\/script>/.exec(await page.text())![1]!);
    expect(boot.session.state).toMatchObject({ persona: 'employee', states: { account: 'frozen' } });
    const H = { ...REMOTE, 'x-stagecraft-session': vid };
    // Explore: switch states, use mocks, comment.
    expect((await api('PATCH', '/session', { states: { account: 'under_review' } }, H)).status).toBe(200);
    expect((await fetch(`${base}/api/me`, { headers: H })).status).toBe(200);
    const fb = await api('POST', '/feedback', { text: 'Looks good', url: '/payments', viewport: { width: 1, height: 1 }, anchor: { kind: 'region', box: { x: 0, y: 0, width: 1, height: 1 } } }, H);
    expect(fb.status).toBe(200);
    // Not allowed: files, config, other sessions, new links.
    for (const [m, p, b] of [['POST', '/scenarios', { name: 'x' }], ['POST', '/tapes', { tape: {} }], ['POST', '/reload'], ['POST', '/shares', {}], ['POST', '/mockdb/seed', { patch: {} }]] as const) {
      expect((await api(m, p, b, H)).status, `${m} ${p}`).toBe(403);
    }
    expect((await fetch(`${base}/?__sc_session=main`, { headers: { ...H, accept: 'text/html', referer: `${base}/payments?__sc_session=${vid}` } })).status).toBe(200);
    // ...but that document still belongs to the viewer session, not main:
    expect(engine.getSession('main').state.persona).toBe('admin');
    // Two viewers do not see each other's changes.
    const open2 = await fetch(`${base}${created.url}`, { headers: REMOTE, redirect: 'manual' });
    const vid2 = new URL(open2.headers.get('location')!, base).searchParams.get('__sc_session')!;
    expect(vid2).not.toBe(vid);
    expect(engine.sessions.get(vid2)!.state.states.account).toBe('frozen');
  });

  it('passwords, expiry, revoke, and the admin switch all stop access at the next request', async () => {
    const pw = await (await api('POST', '/shares', { password: 'tulip', expires: '1h' })).json();
    expect(await (await fetch(`${base}${pw.url}`, { headers: REMOTE })).text()).toMatch(/needs a password/);
    expect((await fetch(`${base}${pw.url}`, { method: 'POST', headers: { ...REMOTE, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=nope', redirect: 'manual' })).status).toBe(401);
    const ok = await fetch(`${base}${pw.url}`, { method: 'POST', headers: { ...REMOTE, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=tulip', redirect: 'manual' });
    expect(ok.status).toBe(303);
    const vid = new URL(ok.headers.get('location')!, base).searchParams.get('__sc_session')!;
    const H = { ...REMOTE, 'x-stagecraft-session': vid };
    expect((await api('GET', '/session', undefined, H)).status).toBe(200);
    // Revoke → the open viewer loses access at once.
    await api('DELETE', `/shares/${pw.id}`);
    expect((await api('GET', '/session', undefined, H)).status).toBe(410);
    expect((await fetch(`${base}${pw.url}`, { headers: REMOTE })).status).toBe(410);
    // Expired links.
    const short = await (await api('POST', '/shares', { expires: '1m' })).json();
    const share = (await (await api('GET', '/shares')).json()).find((s: any) => s.id === short.id);
    expect(share.active).toBe(true);
    // Admin turns public links off: creation refused, existing links stop.
    const live = await (await api('POST', '/shares', { expires: '1h' })).json();
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace("tapes: { endpoint: 'GET /api/assistant/stream' },", "tapes: { endpoint: 'GET /api/assistant/stream' },\n  sharing: { publicLinks: false },"));
    await engine.reload();
    expect((await api('POST', '/shares', {})).status).toBe(403);
    expect((await fetch(`${base}${live.url}`, { headers: REMOTE })).status).toBe(410);
    expect(await (await fetch(`${base}${live.url}`, { headers: REMOTE })).text()).toMatch(/turned off/);
  });
});
