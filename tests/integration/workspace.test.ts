import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, readOpenApi, specCoverage } from '@stagecraft/server';
import { doctor } from 'stagecraft';
import { multiRepoFixture, REPO } from '../helpers.ts';

const BIN = join(REPO, 'packages/cli/src/bin.ts');
const sc = (cwd: string, ...args: string[]) => spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8' });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('multi-repo workspace (CLI)', () => {
  it('links the library into every app, and unlinks back to the installed copy', () => {
    const fx = multiRepoFixture({ web: 5991, admin: 5992 });
    // An installed (published) copy exists before linking.
    mkdirSync(join(fx.web, 'node_modules/@acme/ui'), { recursive: true });
    writeFileSync(join(fx.web, 'node_modules/@acme/ui/package.json'), '{"name":"@acme/ui","version":"3.1.0"}');
    expect(sc(fx.web, 'workspace', 'link').status).toBe(0);
    for (const app of [fx.web, fx.admin]) {
      const p = join(app, 'node_modules/@acme/ui');
      expect(lstatSync(p).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version).toBe('3.2.0');
    }
    expect(sc(fx.web, 'workspace', 'status').stdout).toMatch(/✓ @acme\/ui linked/);
    expect(sc(fx.web, 'workspace', 'unlink').status).toBe(0);
    expect(lstatSync(join(fx.web, 'node_modules/@acme/ui')).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(fx.web, 'node_modules/@acme/ui/package.json'), 'utf8')).version).toBe('3.1.0');
    expect(existsSync(join(fx.admin, 'node_modules/@acme/ui'))).toBe(false);
  });

  it('puts every writable repo on one prototype branch and reports changed repos for handoff', () => {
    const fx = multiRepoFixture({ web: 5993, admin: 5994 });
    expect(sc(fx.web, 'workspace', 'branch', 'agent-controls').status).toBe(0);
    for (const r of [fx.web, fx.ui, fx.admin]) expect(git(r, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('proto/agent-controls');
    expect(git(fx.api, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // read-only repo untouched
    writeFileSync(join(fx.ui, 'src/Pill.tsx'), 'export const Pill = () => null;\n');
    writeFileSync(join(fx.web, 'src/extra.ts'), 'export {};\n');
    const st = JSON.parse(sc(fx.web, 'workspace', 'status', '--json').stdout);
    const changed = st.filter((r: any) => r.changedFiles.length).map((r: any) => r.name);
    expect(changed.sort()).toEqual(['(host)', 'ui']);
    expect(sc(fx.web, 'workspace', 'status').stdout).toMatch(/Handoff: 2 PRs \(\(host\), ui\)/);
    // Running it again switches to the existing branch.
    git(fx.web, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'x', '--allow-empty');
    expect(sc(fx.web, 'workspace', 'branch', 'proto/agent-controls').stdout).toMatch(/\(host\): on proto\/agent-controls\n/);
  });

  it('clones missing repos from their git URL', () => {
    const fx = multiRepoFixture({ web: 5995, admin: 5996 });
    const bare = join(fx.root, 'remote-ui.git');
    git(fx.root, 'clone', '-q', '--bare', fx.ui, bare);
    rmSync(fx.ui, { recursive: true });
    const cfg = join(fx.web, 'stagecraft.config.ts');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('https://github.com/acme/ui.git', bare));
    expect(sc(fx.web, 'workspace', 'status').status).toBe(1);
    expect(sc(fx.web, 'workspace', 'clone').status).toBe(0);
    expect(existsSync(join(fx.ui, 'src/index.tsx'))).toBe(true);
  });

  it('doctor checks links, branches, read-only repos and mocks against the OpenAPI spec', async () => {
    const fx = multiRepoFixture({ web: 5997, admin: 5998 });
    let r = await doctor(fx.web);
    expect(r.warnings.join('\n')).toMatch(/@acme\/ui is not linked into \(host\)/);
    expect(r.ok.join('\n')).toMatch(/Mocks match the api OpenAPI spec/);
    sc(fx.web, 'workspace', 'link');
    // The backend adds an endpoint; the prototype adds a mock for an endpoint the API does not have.
    const spec = JSON.parse(readFileSync(join(fx.api, 'openapi.json'), 'utf8'));
    spec.paths['/v1/payments/{id}/refund'] = { post: { responses: {} } };
    writeFileSync(join(fx.api, 'openapi.json'), JSON.stringify(spec));
    const mocks = join(fx.web, 'stagecraft/mocks.ts');
    writeFileSync(mocks, readFileSync(mocks, 'utf8').replace("'GET /v1/payments':", "'GET /v1/insights': () => [],\n  'GET /v1/payments':"));
    sc(fx.web, 'workspace', 'branch', 'x');
    git(fx.admin, 'checkout', '-q', 'main');
    writeFileSync(join(fx.admin, 'src/new.ts'), 'export {};\n');
    writeFileSync(join(fx.ui, 'src/new.ts'), 'export {};\n');
    r = await doctor(fx.web);
    const w = r.warnings.join('\n');
    expect(w).not.toMatch(/not linked/);
    expect(w).toMatch(/with no mock:\n\s+POST \/v1\/payments\/:id\/refund/);
    expect(w).toMatch(/not in the api spec[\s\S]*GET \/v1\/insights/);
    expect(w).toMatch(/Read-only repo "api" has changes: openapi\.json/);
    expect(w).toMatch(/different branches/);
  });

  it('generates agent context for every repo', () => {
    const fx = multiRepoFixture({ web: 5999, admin: 6000 });
    expect(sc(fx.web, 'agents', 'sync').status).toBe(0);
    const settings = JSON.parse(readFileSync(join(fx.web, '.claude/settings.json'), 'utf8'));
    expect(settings.permissions.additionalDirectories).toEqual(['../acme-ui', '../acme-admin', '../acme-api']);
    expect(settings.permissions.allow).toContain('mcp__stagecraft');
    const ws = JSON.parse(readFileSync(join(fx.web, 'stagecraft.code-workspace'), 'utf8'));
    expect(ws.folders.map((f: any) => f.path)).toEqual(['.', '../acme-ui', '../acme-admin', '../acme-api']);
    const agents = readFileSync(join(fx.web, 'AGENTS.md'), 'utf8');
    expect(agents).toMatch(/\| api \| `..\/acme-api` \| api \| Read-only\. Do not edit\. `openapi.json` is the API contract/);
    expect(sc(fx.web, 'agents', 'check').status).toBe(0);
  });
});

describe('OpenAPI reading', () => {
  it('reads JSON and YAML specs with server path prefixes', () => {
    const fx = multiRepoFixture({ web: 6001, admin: 6002 });
    const y = join(fx.api, 'spec.yaml');
    writeFileSync(y, 'openapi: 3.0.0\nservers:\n  - url: https://x.example/api\npaths:\n  /things/{id}:\n    get: {}\n    delete: {}\n');
    expect(readOpenApi(y)).toEqual([
      { method: 'GET', path: '/api/things/:id', operationId: undefined },
      { method: 'DELETE', path: '/api/things/:id', operationId: undefined },
    ]);
    const cov = specCoverage(readOpenApi(y), [compile('GET /api/things/:thingId', 1), compile('* /api/other', 1)]);
    expect(cov).toEqual({ unmocked: ['DELETE /api/things/:id'], notInSpec: ['* /api/other'] });
  });
});

describe('port-mounted workspace apps', () => {
  it('serves an app that cannot use a base path on its own port, on the same engine', async () => {
    const http = await import('node:http');
    const { startServer } = await import('@stagecraft/server');
    const { freePort } = await import('../helpers.ts');
    const mk = (body: string) =>
      new Promise<import('node:http').Server>((res) => {
        const s = http.createServer((_q, r) => {
          r.writeHead(200, { 'content-type': 'text/html' });
          r.end(`<html><head></head><body>${body}</body></html>`);
        });
        s.listen(0, '127.0.0.1', () => res(s));
      });
    const web = await mk('WEB');
    const admin = await mk('ADMIN');
    const fx = multiRepoFixture({ web: (web.address() as any).port, admin: (admin.address() as any).port });
    const adminPort = await freePort();
    const cfg = join(fx.web, 'stagecraft.config.ts');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace("mount: '/admin'", `port: ${adminPort}`).replace(/localhost:(\d+)/g, '127.0.0.1:$1'));
    const s = await startServer(cfg, { port: 0, watch: false, log: () => {} });
    expect(s.apps.map((a) => a.name)).toEqual(['admin']);
    const html = async (u: string) => (await fetch(u, { headers: { accept: 'text/html' } })).text();
    expect(await html(s.url + '/')).toContain('WEB');
    const a = await html(s.apps[0]!.url + '/');
    expect(a).toContain('ADMIN');
    expect(a).toContain('__STAGECRAFT_BOOT__');
    // Same engine: a state set through the host port is what the admin port's mocks serve.
    await fetch(s.url + '/__stagecraft/api/session', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ states: { account: 'frozen' } }) });
    const acc = await (await fetch(`${s.apps[0]!.url}/__stagecraft/mock/${encodeURIComponent('https://api.acme.example')}/v1/account`)).json();
    expect(acc.status).toBe('frozen');
    await s.server.close();
    web.close();
    admin.close();
  });
});
