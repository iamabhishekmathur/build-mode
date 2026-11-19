import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, Edge, NamespaceDriver, Orchestrator, installFirewall, EgressProxy } from '@stagecraft/cloud';
import { freePort, REPO } from '../helpers.ts';

const driver = new NamespaceDriver();
const ok = driver.available().ok;
const TMP = join(REPO, 'tests/.tmp', `cloud-${Date.now().toString(36)}`);
const DOMAIN = 'preview.test';
const CA = existsSync('/root/.ccr/ca-bundle.crt') ? '/root/.ccr/ca-bundle.crt' : undefined;

function collect(c: import('node:child_process').ChildProcess, ms = 20000): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((r) => {
    let out = '';
    c.stdout?.on('data', (d) => (out += d));
    c.stderr?.on('data', (d) => (out += d));
    const t = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('exit', (code, signal) => {
      clearTimeout(t);
      r({ code, signal, out });
    });
  });
}

/** A customer repo: real npm dependency + lockfile, a tiny dev server, a Stagecraft config. */
function fixtureRepo(): string {
  const src = join(TMP, 'src-repo');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'cloud-fixture', private: true, type: 'module', scripts: { dev: 'node server.mjs' }, dependencies: { 'left-pad': '1.3.0' } }, null, 2));
  writeFileSync(
    join(src, 'server.mjs'),
    `import http from 'node:http';
import { createRequire } from 'node:module';
const leftPad = createRequire(import.meta.url)('left-pad');
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head><title>Fixture</title></head><body><h1>' + leftPad('7', 3, '0') + '</h1></body></html>');
}).listen(5173, '127.0.0.1');`,
  );
  writeFileSync(
    join(src, 'stagecraft.config.mjs'),
    `export default {
  devCommand: 'node server.mjs',
  devUrl: 'http://127.0.0.1:5173',
  port: 4400,
  apiOrigins: ['/api'],
  handlers: {
    'GET /api/hello': () => ({ msg: 'hello from mock' }),
    'POST /api/count': ({ db }) => ({ count: ++db.count }),
    'GET /api/count': ({ db }) => ({ count: db.count }),
  },
  seed: { count: 0 },
  personas: { owner: { label: 'Owner' } },
  defaultPersona: 'owner',
};`,
  );
  // Lockfile made on the host (trusted), install happens in the sandbox (untrusted scripts).
  execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: src, stdio: 'pipe' });
  const bare = join(TMP, 'repo.git');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' });
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'customer repo');
  git(TMP, 'clone', '-q', '--bare', src, bare);
  return bare;
}

/** HTTP to the edge with a Host header (fetch cannot set Host). */
function edge(port: number, sid: string, path: string, opts: { cookie?: string; method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: `${sid}.${DOMAIN}`, accept: 'text/html', ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe.skipIf(!ok)('cloud runtime: namespace sandboxes (needs root)', () => {
  let orch: Orchestrator;
  let api: Api;
  let edgeSrv: Edge;
  let apiBase = '';
  let edgePort = 0;
  const ADMIN = randomBytes(24).toString('base64url');
  let tenantToken = '';
  let otherToken = '';
  let wsId = '';
  const call = async (token: string, method: string, path: string, b?: unknown) => {
    const r = await fetch(`${apiBase}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json() };
  };

  beforeAll(async () => {
    mkdirSync(TMP, { recursive: true });
    edgePort = await freePort();
    orch = new Orchestrator({
      dataDir: join(TMP, 'data'),
      masterKey: randomBytes(32).toString('base64'),
      driver,
      platform: { nodeDir: join(process.execPath, '../..'), stagecraftDir: REPO, caFile: CA },
      previewDomain: DOMAIN,
      previewScheme: 'http',
      previewPort: edgePort,
      edgeSecret: randomBytes(32).toString('base64url'),
      upstreamProxy: process.env.HTTPS_PROXY,
      warmPool: 1,
      log: () => {},
    });
    await orch.start();
    api = new Api(orch, ADMIN);
    apiBase = `http://127.0.0.1:${await api.listen(0)}`;
    edgeSrv = new Edge(orch, { previewDomain: DOMAIN, edgeSecret: (orch as any).o.edgeSecret });
    await edgeSrv.listen(edgePort, '127.0.0.1');
    tenantToken = (await call(ADMIN, 'POST', '/v1/tenants', { id: 'acme', name: 'Acme' })).body.adminToken;
    otherToken = (await call(ADMIN, 'POST', '/v1/tenants', { id: 'globex', name: 'Globex' })).body.adminToken;
  }, 120_000);

  afterAll(async () => {
    await orch?.shutdown();
    await api?.close();
    await edgeSrv?.close();
  });

  describe('isolation of one sandbox (PRD 6.7, 6.8)', () => {
    it('filesystem, users, processes, network and egress', async () => {
      const ws = join(TMP, 'iso-ws');
      mkdirSync(ws, { recursive: true });
      const a = await driver.create({ id: 'isoa', slot: 240, limits: { memoryMb: 256, cpuPercent: 100, pids: 64 }, workspace: ws, mounts: [{ host: join(process.execPath, '../..'), sandbox: join(process.execPath, '../..') }, ...(CA ? [{ host: CA, sandbox: '/opt/stagecraft/ca.crt' }] : [])], env: { PATH: `${join(process.execPath, '..')}:/usr/bin:/bin`, HTTPS_PROXY: 'http://10.231.240.1:3128', NODE_USE_ENV_PROXY: '1', ...(CA ? { NODE_EXTRA_CA_CERTS: '/opt/stagecraft/ca.crt' } : {}), SECRET_PROBE: 'zz-secret-zz' } });
      const b = await driver.create({ id: 'isob', slot: 241, limits: { memoryMb: 256, cpuPercent: 100, pids: 64 }, workspace: ws, mounts: [], env: { PATH: '/usr/bin:/bin' } });
      try {
        const sh = (cmd: string) => collect(a.exec(['/bin/sh', '-c', cmd]));
        const r = await sh('id -u; ls /root /home 2>&1 | wc -l; touch /usr/x 2>&1 | grep -c Read-only; echo w > /workspace/ok && cat /workspace/ok; cat /etc/shadow 2>/dev/null | wc -c; tr "\\0" "\\n" < /proc/1/cmdline | grep -c "zz-sec""ret-zz" || true; ls /proc | grep -cE "^[0-9]+$"');
        const [uid, noHome, ro, w, shadow, setenv, procs] = r.out.trim().split('\n');
        expect(uid).toBe('1000'); // unprivileged
        expect(noHome).toBe('2'); // two "cannot access" lines: no /root, no /home
        expect(ro).toBe('1'); // system dirs read-only
        expect(w).toBe('w'); // workspace writable
        expect(shadow).toBe('0'); // masked / unreadable
        expect(setenv).toBe('0'); // env never in argv (/proc/<pid>/cmdline)
        expect(Number(procs)).toBeLessThan(10); // own PID namespace: host processes invisible
        // No route out; host ports refused; neighbour sandbox unreachable.
        const node = join(process.execPath);
        const tcp = (host: string, port: number) => collect(a.exec([node, '-e', `require('net').connect(${port},'${host}').on('error',e=>{console.log(e.code);process.exit(0)}).on('connect',()=>{console.log('OPEN');process.exit(0)})`]));
        const last = (r: { out: string }) => r.out.trim().split("\n").pop();
        expect(last(await tcp('1.1.1.1', 443))).toBe('ENETUNREACH');
        expect(last(await tcp('10.231.240.1', 22))).toMatch(/ECONNREFUSED|EHOSTUNREACH/);
        expect(last(await tcp(b.ip, 80))).toMatch(/ENETUNREACH|EHOSTUNREACH|ECONNREFUSED/);
        // Egress only through the proxy, only to allowed hosts, every decision logged.
        orch.egress.register(a.ip, 'acme', []);
        const js = `for (const u of ['https://registry.npmjs.org/left-pad','https://example.com/']) { try { const r = await fetch(u,{signal:AbortSignal.timeout(20000)}); console.log(u, r.status) } catch (e) { console.log(u, 'BLOCKED') } }`;
        const eg = await collect(a.exec([node, '--input-type=module', '-e', js], { env: {} }), 45000);
        expect(eg.out).toMatch(/registry\.npmjs\.org\/left-pad 200/);
        expect(eg.out).toMatch(/example\.com\/ BLOCKED/);
        const decisions = orch.egress.decisions.filter((d) => d.sandboxIp === a.ip);
        expect(decisions.find((d) => d.host === 'example.com')?.allowed).toBe(false);
        expect(decisions.find((d) => d.host === 'registry.npmjs.org')?.allowed).toBe(true);
        orch.egress.unregister(a.ip);
      } finally {
        await a.destroy();
        await b.destroy();
      }
    }, 90_000);

    it('memory and process limits are enforced (noisy neighbours)', async () => {
      const ws = join(TMP, 'lim-ws');
      mkdirSync(ws, { recursive: true });
      const nodeDir = join(process.execPath, '../..');
      const sb = await driver.create({ id: 'lim', slot: 242, limits: { memoryMb: 128, cpuPercent: 50, pids: 32 }, workspace: ws, mounts: [{ host: nodeDir, sandbox: nodeDir }], env: { PATH: `${join(process.execPath, '..')}:/usr/bin:/bin` } });
      try {
        const mem = await collect(sb.exec([process.execPath, '-e', 'const a=[];for(;;){a.push(Buffer.alloc(16*1024*1024,1))}']), 30000);
        expect(mem.signal ?? String(mem.code)).toMatch(/SIGKILL|137|9/);
        expect(sb.stats().oomKills).toBeGreaterThan(0);
        const fork = await collect(sb.exec(['/bin/sh', '-c', 'for i in $(seq 1 100); do sleep 5 & done; echo started-all']), 20000);
        expect(fork.out).toMatch(/Cannot fork|Resource temporarily unavailable/i);
        expect(fork.out).not.toContain('started-all');
      } finally {
        await sb.destroy();
      }
    }, 60_000);
  });

  describe('workspaces, sessions, edge (FR-107, FR-203, FR-204, FR-1403)', () => {
    let sid = '';
    let ownerCookie = '';

    it('builds a snapshot (install runs in a sandbox) and reuses it for the same lockfile', async () => {
      const bare = fixtureRepo();
      const r1 = await call(tenantToken, 'POST', '/v1/workspaces', { repoUrl: bare });
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      expect(r1.body.status).toBe('ready');
      wsId = r1.body.id;
      const snap = orch.snapshots.path(r1.body.snapshot);
      expect(existsSync(snap)).toBe(true);
      const r2 = await call(tenantToken, 'POST', '/v1/workspaces', { repoUrl: bare });
      expect(r2.body.snapshot).toBe(r1.body.snapshot);
      console.log(`snapshot build ${r1.body.buildMs} ms, reuse ${r2.body.buildMs} ms, ${Math.round(statSync(snap).size / 1024)} KB`);
      expect(r2.body.buildMs).toBeLessThan(r1.body.buildMs);
      // The install really happened in the sandbox, through the egress proxy.
      expect(orch.egress.decisions.some((d) => d.tenant === 'acme' && d.host === 'registry.npmjs.org' && d.allowed)).toBe(true);
    }, 180_000);

    it('starts a session from the snapshot; the owner logs in through the edge', async () => {
      const r = await call(tenantToken, 'POST', '/v1/sessions', { workspace: wsId });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      sid = r.body.id;
      expect(r.body.previewUrl).toBe(`http://${sid}.${DOMAIN}:${edgePort}`);
      console.log(`session start from snapshot: ${r.body.startMs} ms`);
      expect(r.body.startMs).toBeLessThan(20_000); // NFR-201 p50 target
      const login = new URL(r.body.ownerLoginUrl);
      const lr = await edge(edgePort, sid, login.pathname + login.search);
      expect(lr.status).toBe(303);
      ownerCookie = String(lr.headers['set-cookie']).split(';')[0]!;
      expect(String(lr.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax/);
      const page = await edge(edgePort, sid, '/', { cookie: ownerCookie });
      expect(page.status).toBe(200);
      expect(page.body).toContain('<h1>007</h1>'); // dependency installed in the snapshot
      expect(page.body).toContain('__STAGECRAFT_BOOT__'); // panel injected
      expect(page.headers['x-robots-tag']).toMatch(/noindex/);
      const api = await edge(edgePort, sid, '/api/hello', { cookie: ownerCookie, headers: { accept: 'application/json' } });
      expect(JSON.parse(api.body)).toEqual({ msg: 'hello from mock' });
    }, 120_000);

    it('strangers and spoofed headers get nothing; share links work for viewers', async () => {
      expect((await edge(edgePort, sid, '/')).status).toBe(403);
      expect((await edge(edgePort, sid, '/', { headers: { 'x-stagecraft-edge': `${Math.floor(Date.now() / 1000)}.forged` } })).status).toBe(403);
      expect((await edge(edgePort, sid, '/__stagecraft/api/session', { headers: { 'x-stagecraft-test-remote': '0' } })).status).toBe(403);
      expect((await edge(edgePort, sid, '/__edge/login?t=bogus')).status).toBe(401);
      expect((await edge(edgePort, 'nosuchsession1', '/')).status).toBe(404);
      const share = JSON.parse((await edge(edgePort, sid, '/__stagecraft/api/shares', { cookie: ownerCookie, method: 'POST', body: JSON.stringify({ expires: '1h' }) })).body);
      expect(share.url).toMatch(/^\/__stagecraft\/s\//);
      const open = await edge(edgePort, sid, share.url);
      expect(open.status).toBe(303);
      const viewerPage = await edge(edgePort, sid, open.headers.location!);
      expect(viewerPage.status).toBe(200);
      expect(viewerPage.body).toContain('<h1>007</h1>');
      expect((await edge(edgePort, sid, '/robots.txt')).body).toMatch(/Disallow: \//);
    }, 60_000);

    it('sleeps (state saved), wakes from a link with a loading page, and keeps the mock DB', async () => {
      const post = () => edge(edgePort, sid, '/api/count', { cookie: ownerCookie, method: 'POST', headers: { accept: 'application/json' } });
      await post();
      expect(JSON.parse((await post()).body).count).toBe(2);
      const slept = await call(tenantToken, 'POST', `/v1/sessions/${sid}/sleep`);
      expect(slept.body.status).toBe('sleeping');
      expect(slept.body.stats).toBeNull(); // no processes left
      const wake = await edge(edgePort, sid, '/', { cookie: ownerCookie });
      expect(wake.status).toBe(503);
      expect(wake.body).toMatch(/Waking up the preview/);
      const t0 = Date.now();
      for (let i = 0; i < 120; i++) {
        const st = JSON.parse((await edge(edgePort, sid, '/__edge/status')).body);
        if (st.status === 'running') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      console.log(`resume via link: ${Date.now() - t0} ms`);
      const count = await edge(edgePort, sid, '/api/count', { cookie: ownerCookie, headers: { accept: 'application/json' } });
      expect(JSON.parse(count.body).count).toBe(2);
    }, 120_000);

    it('idle sessions go to sleep on their own', async () => {
      await call(tenantToken, 'PUT', '/v1/policy', { idleTimeoutSec: 1 });
      orch.store.sessions[sid]!.lastActiveAt = new Date(Date.now() - 5000).toISOString();
      await orch.sweep();
      expect(orch.store.sessions[sid]!.status).toBe('sleeping');
      await call(tenantToken, 'PUT', '/v1/policy', { idleTimeoutSec: 1800 });
      await call(tenantToken, 'POST', `/v1/sessions/${sid}/resume`);
    }, 120_000);

    it('runs the agent with the tenant key only in its own process, and never echoes it', async () => {
      const KEY = 'sk-ant-test-' + randomBytes(12).toString('hex');
      await call(tenantToken, 'PUT', '/v1/secrets/ANTHROPIC_API_KEY', { value: KEY });
      const probe = `const k=process.env.ANTHROPIC_API_KEY||'';console.log('has-key', k.length>10, k);
const fs=require('fs');let seen=0;for(const p of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{if(fs.readFileSync('/proc/'+p+'/environ','utf8').includes('sk-ant-test'))seen++}catch{}}console.log('procs-with-key',seen)`;
      const r = await call(tenantToken, 'POST', `/v1/sessions/${sid}/agent`, { command: [process.execPath, '-e', probe], secret: 'ANTHROPIC_API_KEY' });
      expect(r.body.output).toMatch(/has-key true \[secret\]/);
      expect(r.body.output).not.toContain(KEY);
      // Only bwrap + the agent in this exec's own PID namespace; the dev server's namespace is separate.
      expect(Number(/procs-with-key (\d+)/.exec(r.body.output)![1])).toBeLessThanOrEqual(2);
      // The dev server's process tree never had it.
      const dev = await call(tenantToken, 'POST', `/v1/sessions/${sid}/agent`, { command: ['/bin/sh', '-c', 'echo "[${ANTHROPIC_API_KEY:-none}]"'] });
      expect(dev.body.output.trim()).toBe('[none]');
      // At rest: encrypted. No plaintext anywhere in the data dir.
      const files: string[] = [];
      const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name))));
      walk(join(TMP, 'data', 'db'));
      for (const f of files) expect(readFileSync(f, 'utf8').includes(KEY), f).toBe(false);
      expect((await call(tenantToken, 'GET', '/v1/secrets')).body).toEqual(['ANTHROPIC_API_KEY']);
    }, 60_000);

    it('tenants cannot see each other; tokens are scoped; everything is audited', async () => {
      expect((await call(otherToken, 'GET', `/v1/sessions/${sid}`)).status).toBe(404);
      expect((await call(otherToken, 'POST', `/v1/sessions/${sid}/agent`, { command: ['/bin/true'] })).status).toBe(404);
      expect((await call(otherToken, 'POST', '/v1/sessions', { workspace: wsId })).status).toBe(404);
      expect((await call('sct_acme_nope', 'GET', '/v1/usage')).status).toBe(401);
      const builder = (await call(tenantToken, 'POST', '/v1/tokens', { role: 'builder', label: 'dana' })).body.token;
      expect((await call(builder, 'PUT', '/v1/policy', { cloud: false })).status).toBe(403);
      expect((await call(builder, 'GET', `/v1/sessions/${sid}`)).status).toBe(200);
      const audit = (await call(tenantToken, 'GET', '/v1/audit')).body.map((a: any) => a.action);
      expect(audit).toEqual(expect.arrayContaining(['workspace.build', 'session.start', 'session.sleep', 'session.resume', 'secret.set', 'agent.run', 'policy.update', 'token.create']));
      expect(JSON.stringify(readFileSync(join(TMP, 'data', 'db', 'state.json'), 'utf8'))).not.toContain(builder);
    });

    it('strict mode and spend caps block new sessions with a clear message (FR-205, FR-1505)', async () => {
      await call(tenantToken, 'PUT', '/v1/policy', { cloud: false });
      const strict = await call(tenantToken, 'POST', '/v1/sessions', { workspace: wsId });
      expect(strict.status).toBe(403);
      expect(strict.body.error).toMatch(/strict mode/);
      await call(tenantToken, 'PUT', '/v1/policy', { cloud: true, monthlyMinutesCap: 0.0001 });
      const capped = await call(tenantToken, 'POST', '/v1/sessions', { workspace: wsId });
      expect(capped.status).toBe(402);
      expect(capped.body.error).toMatch(/Monthly sandbox limit reached/);
      expect(orch.store.sessions[sid]!.status).toBe('running'); // running ones continue
      expect((await call(tenantToken, 'GET', '/v1/usage')).body.minutesThisMonth).toBeGreaterThan(0);
      await call(tenantToken, 'PUT', '/v1/policy', { monthlyMinutesCap: 0 });
    }, 60_000);

    it('warm starts: three more sessions from the snapshot (NFR-201)', async () => {
      const times: number[] = [];
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await call(tenantToken, 'POST', '/v1/sessions', { workspace: wsId });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        times.push(r.body.startMs);
        ids.push(r.body.id);
      }
      times.sort((a, b) => a - b);
      console.log(`warm start ms: ${times.join(', ')} (p50 ${times[1]})`);
      expect(times[1]).toBeLessThan(20_000);
      // Sessions are isolated from each other: separate sandboxes, separate DBs.
      expect(new Set(ids.map((x) => orch.store.sessions[x]!.ip)).size).toBe(3);
      for (const x of ids) await call(tenantToken, 'DELETE', `/v1/sessions/${x}`);
    }, 180_000);

    it('stopping deletes the code copy (NFR-104)', async () => {
      const dir = orch.store.sessions[sid]!.dir;
      expect(existsSync(dir)).toBe(true);
      const r = await call(tenantToken, 'DELETE', `/v1/sessions/${sid}`);
      expect(r.body.status).toBe('stopped');
      expect(existsSync(dir)).toBe(false);
      expect((await edge(edgePort, sid, '/', { cookie: ownerCookie })).status).toBe(404);
    }, 60_000);
  });
});

describe.skipIf(!ok)('firewall rules', () => {
  it('installs idempotently', () => {
    installFirewall();
    installFirewall();
    const out = execFileSync('/usr/sbin/nft', ['list', 'table', 'inet', 'stagecraft'], { encoding: 'utf8' });
    expect(out).toMatch(/iifname "scv\*" tcp dport 3128 accept/);
    expect(out).toMatch(/iifname "scv\*" counter packets \d+ bytes \d+ reject/);
    void EgressProxy;
  });
});
