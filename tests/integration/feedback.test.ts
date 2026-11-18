import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type StagecraftServer } from '@stagecraft/server';
import { fixture, until } from '../helpers.ts';

let upstream: http.Server;
let server: StagecraftServer;
let base: string;

beforeAll(async () => {
  upstream = http.createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<!doctype html><html><head></head><body style="margin:0"><h1 id="title" style="margin:40px">Payments</h1><button data-testid="pay">Approve</button></body></html>');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const fx = fixture('feedback');
  const s = await startServer(fx.config, { port: 0, devUrl: `http://127.0.0.1:${(upstream.address() as any).port}`, watch: false, log: () => {} });
  server = s.server;
  base = s.url;
});
afterAll(async () => {
  await server?.close();
  upstream?.close();
});

const api = async (method: string, path: string, body?: unknown, agent = false) => {
  const r = await fetch(`${base}/__stagecraft/api${path}`, { method, headers: { 'content-type': 'application/json', ...(agent ? { 'x-stagecraft-actor': 'agent' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
};

describe('feedback loop (FR-901..905)', () => {
  it('stores full context, screenshots it, sends to the agent, takes the reply, and only people resolve', async () => {
    await api('PATCH', '/session', { persona: 'employee', states: { account: 'frozen' }, variants: { layout: 'cards' } });
    const c = await api('POST', '/feedback', {
      text: 'This should say Disconnect',
      author: 'Priya',
      url: '/payments?x=1',
      viewport: { width: 800, height: 600 },
      anchor: { kind: 'element', selector: '[data-testid="pay"]', text: 'Approve', box: { x: 0, y: 100, width: 80, height: 20 } },
      source: { framework: 'react', component: 'Payments', file: '/src/pages/Payments.tsx', line: 42 },
    });
    expect(c.status).toBe(200);
    const fb = c.body;
    // FR-902: every field present.
    expect(fb).toMatchObject({ text: 'This should say Disconnect', author: 'Priya', status: 'open', url: '/payments?x=1', viewport: { width: 800, height: 600 }, source: { file: '/src/pages/Payments.tsx' }, variant: { layout: 'cards' } });
    expect(fb.state).toMatchObject({ persona: 'employee', states: { account: 'frozen' } });
    expect(fb.anchor.selector).toBe('[data-testid="pay"]');
    // Screenshot arrives in the background.
    await until(async () => (await api('GET', `/feedback/${fb.id}`)).body.screenshot === 'before', 30000, 200);
    const png = await fetch(`${base}/__stagecraft/api/feedback/${fb.id}/shot/before.png`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');

    // Agents cannot comment, send, or resolve.
    expect((await api('POST', '/feedback', { text: 'x', url: '/', viewport: { width: 1, height: 1 }, anchor: { kind: 'region', box: { x: 0, y: 0, width: 1, height: 1 } } }, true)).status).toBe(403);
    expect((await api('POST', '/feedback/send', {}, true)).status).toBe(403);
    expect((await api('PATCH', `/feedback/${fb.id}`, { status: 'resolved' }, true)).status).toBe(403);

    // A person sends open comments to the agent.
    const sent = await api('POST', '/feedback/send', {});
    expect(sent.body.map((f: any) => f.id)).toEqual([fb.id]);
    expect((await api('GET', '/feedback?status=sent')).body).toHaveLength(1);

    // People cannot fake an agent reply; the agent's reply gets before/after screenshots.
    expect((await api('POST', `/feedback/${fb.id}/reply`, { text: 'x' })).status).toBe(403);
    const rep = await api('POST', `/feedback/${fb.id}/reply`, { text: 'Changed the label to Disconnect.', commit: 'abc1234' }, true);
    expect(rep.status).toBe(200);
    expect(rep.body.status).toBe('agent_done');
    const last = rep.body.replies.at(-1);
    expect(last).toMatchObject({ actor: 'agent', commit: 'abc1234', before: 'before', after: 'after-1' });
    expect((await fetch(`${base}/__stagecraft/api/feedback/${fb.id}/shot/after-1.png`)).status).toBe(200);

    // Only a person resolves.
    const res = await api('PATCH', `/feedback/${fb.id}`, { status: 'resolved', author: 'Priya' });
    expect(res.body.status).toBe('resolved');
  }, 90000);

  it('rejects incomplete comments', async () => {
    expect((await api('POST', '/feedback', { text: '  ', url: '/', viewport: { width: 1, height: 1 }, anchor: { kind: 'region', box: { x: 0, y: 0, width: 1, height: 1 } } })).status).toBe(400);
    expect((await api('PATCH', '/feedback/nope', { status: 'resolved' })).status).toBe(404);
  });
});
