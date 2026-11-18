import http from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer, type StagecraftServer } from '@stagecraft/server';
import { fixture, REPO } from '../helpers.ts';

let client: Client;
let server: StagecraftServer;
let upstream: http.Server;
let root: string;

beforeAll(async () => {
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>t</title></head><body style="background:#fff"><h1>Hello</h1></body></html>');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const fx = fixture('mcp');
  root = fx.root;
  const s = await startServer(fx.config, { port: 0, devUrl: `http://127.0.0.1:${(upstream.address() as any).port}`, watch: false, log: () => {} });
  server = s.server;
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(REPO, 'packages/mcp/src/bin.ts')], cwd: root, env: { ...process.env, STAGECRAFT_URL: s.url } as Record<string, string> }));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  upstream?.close();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content.find((c: any) => c.type === 'text')?.text;
  return { isError: !!r.isError, data: text ? JSON.parse(text) : null, raw: r };
};

describe('stagecraft-mcp (FR-302, FR-505)', () => {
  it('exposes the tool list with API-safe names and schemas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['setup_detect', 'state_catalog', 'state_set', 'persona_set', 'flags_list', 'flags_set', 'variant_list', 'variant_select', 'scenario_save', 'scenario_load', 'scenario_list', 'mockdb_query', 'mockdb_seed', 'mockdb_reset', 'mock_endpoints', 'fault_set', 'tape_create', 'tape_validate', 'tape_play', 'tape_control', 'preview_url', 'preview_navigate', 'preview_screenshot', 'session_get']) {
      expect(names).toContain(n);
    }
    // Anthropic and OpenAI tool-name rule.
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('sets states and personas, and reads/seeds/resets the mock DB', async () => {
    expect((await call('state_set', { states: { account: 'frozen' } })).data.state.states.account).toBe('frozen');
    expect((await call('persona_set', { persona: 'employee' })).data.state.persona).toBe('employee');
    expect((await call('mockdb_query', { path: 'account.status' })).data.value).toBe('frozen');
    await call('mockdb_seed', { patch: { 'users[id=u2].onboardingStep': 3 } });
    expect((await call('mockdb_query', { path: 'users[id=u2].onboardingStep' })).data.value).toBe(3);
    await call('mockdb_reset');
    expect((await call('mockdb_query', { path: 'users[id=u2].onboardingStep' })).data.value).toBe(1);
  });

  it('returns structured errors', async () => {
    const r = await call('state_set', { states: { account: 'melted' } });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/Unknown state "melted" for account. Known: active, frozen/);
    const v = await call('tape_validate', { tape: { version: 1, id: 'x', title: 'x', events: [{ type: 'nope' }] } });
    expect(v.data.valid).toBe(false);
  });

  it('creates and plays a tape, saves and lists scenarios', async () => {
    const tape = { version: 1, id: 'hello', title: 'Hello', events: [{ type: 'user_message', text: 'hi' }, { type: 'agent_message', text: 'Hello!' }] };
    expect((await call('tape_create', { tape })).data.file).toMatch(/stagecraft\/tapes\/hello\.json$/);
    expect((await call('tape_play', { id: 'hello', at: '1' })).data).toMatchObject({ id: 'hello', index: 1, playing: false });
    await call('scenario_save', { name: 'MCP saved', url: '/' });
    expect((await call('scenario_list')).data.map((s: any) => s.name)).toContain('MCP saved');
  });

  it('takes a screenshot of a forked session', async () => {
    const r = await call('preview_screenshot', { path: '/', width: 400, height: 300 });
    expect(r.isError).toBe(false);
    const img = r.raw.content.find((c: any) => c.type === 'image');
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
  }, 30000);

  it('explains when the proxy is down', async () => {
    const c2 = new Client({ name: 't2', version: '1' });
    await c2.connect(new StdioClientTransport({ command: 'node', args: [join(REPO, 'packages/mcp/src/bin.ts')], cwd: root, env: { ...process.env, STAGECRAFT_URL: 'http://127.0.0.1:1' } as Record<string, string> }));
    const r: any = await c2.callTool({ name: 'session_get', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not running.*stagecraft dev/);
    await c2.close();
  });
});
