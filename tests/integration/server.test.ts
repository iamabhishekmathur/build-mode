import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { startServer, type StagecraftServer, type Engine } from '@stagecraft/server';
import { encodeShareState } from '@stagecraft/core';
import { fixture, until } from '../helpers.ts';

/** A fake dev server: HTML with a strict CSP, a JS file, and a "real backend" route that must never be hit. */
let upstream: http.Server;
let upstreamHits: string[] = [];
let upstreamHeaders: http.IncomingHttpHeaders[] = [];
let base: string;
let server: StagecraftServer;
let engine: Engine;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url!);
    upstreamHeaders.push(req.headers);
    if (req.url!.startsWith('/app.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('console.log(1)');
    }
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'self'" });
    res.end('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><title>x</title></head><body><div id=root></div></body></html>');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const port = (upstream.address() as any).port;
  const fx = fixture('server');
  const started = await startServer(fx.config, { port: 0, devUrl: `http://127.0.0.1:${port}`, watch: false, log: () => {}, tapeSpeed: 0.02 });
  ({ server, engine } = started);
  base = started.url;
});

afterAll(async () => {
  await server.close();
  upstream.close();
});

const api = async (method: string, path: string, body?: unknown, sid?: string) => {
  const r = await fetch(`${base}/__stagecraft/api${path}`, { method, headers: { 'content-type': 'application/json', ...(sid ? { 'x-stagecraft-session': sid } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const html = (path: string) => fetch(base + path, { headers: { accept: 'text/html' } });

describe('proxy and injection (FR-801, FR-104)', () => {
  it('injects the boot data and runtime into HTML and strips CSP', async () => {
    const r = await html('/');
    const text = await r.text();
    expect(r.headers.get('content-security-policy')).toBeNull();
    expect(text).not.toMatch(/Content-Security-Policy/i);
    expect(text).toMatch(/<head><script>window.__STAGECRAFT_BOOT__=/);
    expect(text).toContain('<script src="/__stagecraft/runtime.js"></script>');
  });

  it('passes non-HTML through untouched and serves the runtime', async () => {
    expect(await (await fetch(`${base}/app.js`)).text()).toBe('console.log(1)');
    const rt = await fetch(`${base}/__stagecraft/runtime.js`);
    expect(rt.headers.get('content-type')).toMatch(/javascript/);
    expect((await rt.text()).length).toBeGreaterThan(1000);
  });

  it('shows a helpful page when the dev server is down', async () => {
    const fx = fixture('down');
    const s = await startServer(fx.config, { port: 0, devUrl: 'http://127.0.0.1:1', watch: false, log: () => {} });
    const r = await fetch(s.url + '/', { headers: { accept: 'text/html' } });
    expect(r.status).toBe(502);
    expect(await r.text()).toMatch(/Dev server not reachable/);
    await s.server.close();
  });
});

describe('mocks (FR-501, FR-503, FR-409)', () => {
  it('serves same-origin and cross-origin API calls from mocks, never the backend', async () => {
    upstreamHits = [];
    const me = await (await fetch(`${base}/api/me`)).json();
    expect(me.name).toBe('Ada Okafor');
    const agents = await (await fetch(`${base}/__stagecraft/mock/${encodeURIComponent('https://api.ledgerly.example')}/api/agents`)).json();
    expect(agents).toHaveLength(2);
    expect(upstreamHits).toEqual([]);
  });

  it('records unmocked endpoints and returns 404 instead of forwarding', async () => {
    upstreamHits = [];
    const r = await fetch(`${base}/api/invoices`);
    expect(r.status).toBe(404);
    expect(r.headers.get('x-stagecraft-unmocked')).toBe('1');
    expect(upstreamHits).toEqual([]);
    const eps = (await api('GET', '/endpoints')).body;
    expect(eps.unmocked).toContainEqual({ endpoint: 'GET /api/invoices', count: 1 });
  });

  it('persists writes per session and checks the persona', async () => {
    const sid = engine.fork('main').id;
    const post = (path: string) => fetch(base + path, { method: 'POST', headers: { 'x-stagecraft-session': sid } });
    await api('PATCH', '/session', { persona: 'employee', states: { approvals: 'pending' } }, sid);
    expect((await post('/api/payments/p3/approve')).status).toBe(403);
    await api('PATCH', '/session', { persona: 'admin' }, sid);
    expect((await (await post('/api/payments/p3/approve')).json()).status).toBe('approved');
    const q = await api('GET', '/mockdb?path=' + encodeURIComponent('payments[id=p3].status'), undefined, sid);
    expect(q.body.value).toBe('approved');
    // Main session is untouched.
    expect((await api('GET', '/mockdb?path=' + encodeURIComponent('payments[id=p3]'))).body.value).toBeNull();
  });

  it('injects faults: status, latency and no response', async () => {
    const sid = engine.fork('main').id;
    const get = (p: string, signal?: AbortSignal) => fetch(base + p, { headers: { 'x-stagecraft-session': sid }, signal });
    await api('PATCH', '/session', { faults: [{ endpoint: 'GET /api/payments', status: 504 }, { endpoint: '/api/account', latencyMs: 150 }, { endpoint: 'GET /api/me', timeout: true }] }, sid);
    expect((await get('/api/payments')).status).toBe(504);
    const t0 = Date.now();
    expect((await get('/api/account')).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    await expect(get('/api/me', AbortSignal.timeout(300))).rejects.toThrow();
  });
});

describe('links and sessions (FR-806, FR-504)', () => {
  it('applies __sc on a document request, idempotently', async () => {
    const sc = encodeShareState({ persona: 'employee', states: { account: 'frozen', approvals: 'none', agents: 'some' }, flags: { 'new-nav': true }, variants: {}, faults: [] }, engine.defaultState());
    await html(`/?__sc=${sc}`);
    const s = (await api('GET', '/session')).body;
    expect(s.state.persona).toBe('employee');
    expect(s.state.states.account).toBe('frozen');
    expect(s.flags['new-nav']).toBe(true);
    // A write, then a reload with the same link: the write survives.
    await api('POST', '/mockdb/seed', { patch: { 'account.balance': 5 } });
    await html(`/?__sc=${sc}`);
    expect((await api('GET', '/mockdb?path=account.balance')).body.value).toBe(5);
    // A link with no __sc fields means defaults.
    await html(`/?__sc=`);
    expect((await api('GET', '/session')).body.state.persona).toBe('admin');
  });

  it('forks a session for share links and loads scenarios and tapes from params', async () => {
    const r = await html('/?__sc_session=fork&sc_scenario=over-limit-admin&sc_tape=vendor-payment-approval&sc_step=9');
    const boot = JSON.parse(/__STAGECRAFT_BOOT__=(.*?);<\/script>/.exec(await r.text())![1]!);
    expect(boot.session.id).toMatch(/^f/);
    expect(boot.session.state.states.account).toBe('over_limit');
    expect(boot.session.tape).toMatchObject({ id: 'vendor-payment-approval', at: '9', waiting: 'branch' });
  });
});

describe('scenarios and tapes over HTTP', () => {
  it('saves and loads scenarios', async () => {
    const sid = engine.fork('main').id;
    await api('PATCH', '/session', { states: { agents: 'none' } }, sid);
    const saved = await api('POST', '/scenarios', { name: 'No agents yet', url: '/settings/agents' }, sid);
    expect(saved.body.file).toMatch(/stagecraft\/scenarios\/no-agents-yet\.json$/);
    const other = engine.fork('main').id;
    const loaded = await api('POST', '/scenarios/load', { name: 'No agents yet' }, other);
    expect(loaded.body.url).toBe('/settings/agents');
    expect((await api('GET', '/mockdb?path=agents', undefined, other)).body.value).toEqual([]);
  });

  it('streams a tape over SSE in the plain message format', async () => {
    const sid = engine.fork('main').id;
    await api('POST', '/tape/load', { id: 'assistant-stream-error' }, sid);
    const res = await fetch(`${base}/api/assistant/stream?__sc_sid=${sid}`);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    let buf = '';
    await until(async () => {
      const { value } = await reader.read();
      buf += new TextDecoder().decode(value);
      return buf.includes('"type":"done"');
    }, 4000, 0);
    reader.cancel();
    const types = buf.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, '')).type);
    expect(types[0]).toBe('hello');
    expect(types).toContain('user_message');
    expect(types).toContain('token');
    expect(types.slice(-2)).toEqual(['error', 'done']);
    expect(buf).not.toMatch(/^event:/m);
  });

  it('validates tapes and returns structured errors', async () => {
    const r = await api('POST', '/tapes/validate', { tape: { version: 1, id: 'x', title: 'x', events: [{ type: 'bogus' }] } });
    expect(r.body.valid).toBe(false);
    expect(r.body.issues[0].path).toBe('$.events[0].type');
    const bad = await api('POST', '/tape/control', { action: 'play' }, engine.fork('main').id);
    expect(bad.status).toBe(409);
  });
});

describe('websocket tape transport (FR-703)', () => {
  it('plays a tape over WebSocket', async () => {
    const fx = fixture('ws');
    const cfgPath = fx.config;
    const { readFileSync } = await import('node:fs');
    writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace("tapes: { endpoint: 'GET /api/assistant/stream' }", "tapes: { endpoint: 'GET /api/assistant/ws', transport: 'websocket' }"));
    const s = await startServer(cfgPath, { port: 0, devUrl: 'http://127.0.0.1:1', watch: false, log: () => {}, tapeSpeed: 0.02 });
    s.engine.loadTape(s.engine.getSession(), 'assistant-stream-error');
    const ws = new WebSocket(s.url.replace('http', 'ws') + '/api/assistant/ws');
    const got: any[] = [];
    ws.on('message', (m) => got.push(JSON.parse(String(m))));
    await until(() => got.some((e) => e.type === 'error'), 4000);
    expect(got[0].type).toBe('hello');
    expect(got.map((e) => e.type)).toContain('user_message');
    ws.close();
    await s.server.close();
  });
});

describe('session propagation for server rendering (SSR)', () => {
  it('forwards the session to the dev server and rewrites Origin to the dev origin', async () => {
    const sid = engine.fork('main').id;
    upstreamHeaders = [];
    await fetch(`${base}/app.js`, { headers: { 'x-stagecraft-session': sid, origin: base } });
    expect(upstreamHeaders[0]![`x-stagecraft-session`]).toBe(sid);
    expect(upstreamHeaders[0]!.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(upstreamHeaders[0]!.origin).not.toBe(base);
  });

  it('finds a forked session from the Referer on full navigations', async () => {
    const f = engine.fork('main');
    engine.patch(f, { persona: 'employee' });
    upstreamHeaders = [];
    const r = await fetch(`${base}/payments`, { headers: { accept: 'text/html', referer: `${base}/?__sc_session=${f.id}` } });
    const boot = JSON.parse(/__STAGECRAFT_BOOT__=(.*?);<\/script>/.exec(await r.text())![1]!);
    expect(boot.session.id).toBe(f.id);
    expect(upstreamHeaders[0]!['x-stagecraft-session']).toBe(f.id);
    // An unknown id in the Referer falls back to main.
    upstreamHeaders = [];
    await fetch(`${base}/x`, { headers: { accept: 'text/html', referer: `${base}/?__sc_session=nope` } });
    expect(upstreamHeaders[0]!['x-stagecraft-session']).toBe('main');
  });
});
