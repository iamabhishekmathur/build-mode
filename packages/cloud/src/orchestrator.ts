import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hmac, randomId, signToken } from './crypto.ts';
import type { MountSpec, Sandbox, SandboxDriver } from './driver.ts';
import { EGRESS_PORT, installFirewall } from './net.ts';
import { EgressProxy } from './egress.ts';
import { git, installCommand, lockHash, SnapshotStore } from './snapshots.ts';
import { DEFAULT_POLICY, Store, type SessionRec, type Tenant, type Workspace } from './store.ts';

export class CloudError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface PlatformMounts {
  /** Node install dir on the host, mounted at the same path. */
  nodeDir: string;
  /** Stagecraft monorepo (packages + node_modules) on the host, mounted at /opt/stagecraft. */
  stagecraftDir: string;
  /** Extra CA bundle for the egress chain (only when an intercepting upstream proxy exists). */
  caFile?: string;
}

export interface OrchestratorOptions {
  dataDir: string;
  masterKey: string;
  driver: SandboxDriver;
  platform: PlatformMounts;
  /** e.g. preview.stagecraft.dev → https://<session>.preview.stagecraft.dev */
  previewDomain: string;
  previewScheme?: 'https' | 'http';
  /** Port the edge listens on (only for building URLs in dev). */
  previewPort?: number;
  edgeSecret: string;
  upstreamProxy?: string;
  egressPort?: number;
  /** Sandboxes kept created and idle, ready to claim (warm pool). */
  warmPool?: number;
  log?: (m: string) => void;
}

const STAGECRAFT_PORT = 4400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collect(c: ChildProcess, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    c.stdout?.on('data', (d) => (out = (out + d).slice(-20000)));
    c.stderr?.on('data', (d) => (out = (out + d).slice(-20000)));
    const t = setTimeout(() => {
      try {
        process.kill(-c.pid!, 'SIGKILL');
      } catch {
        c.kill('SIGKILL');
      }
    }, timeoutMs);
    c.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

/**
 * Runs prototypes in sandboxes: builds workspace snapshots, starts/sleeps/resumes/stops sessions,
 * meters usage, enforces policy (strict mode, spend caps, idle and wall-clock limits) and wires
 * each sandbox into the egress proxy with its tenant's allowlist.
 */
export class Orchestrator {
  store: Store;
  snapshots: SnapshotStore;
  egress: EgressProxy;
  private o: OrchestratorOptions;
  private freeSlots: number[] = Array.from({ length: 250 }, (_, i) => i + 1);
  private live = new Map<string, { sb: Sandbox; slot: number; dev?: ChildProcess }>();
  private pool: { sb: Sandbox; slot: number; id: string; workspaceRef: { dir: string } }[] = [];
  private sweeper?: ReturnType<typeof setInterval>;
  log: (m: string) => void;

  constructor(o: OrchestratorOptions) {
    this.o = o;
    this.store = new Store(join(o.dataDir, 'db'), o.masterKey);
    this.snapshots = new SnapshotStore(join(o.dataDir, 'snapshots'));
    this.egress = new EgressProxy({ upstreamProxy: o.upstreamProxy });
    this.log = o.log ?? ((m) => console.log(`[cloud] ${m}`));
  }

  async start() {
    const ok = this.o.driver.available();
    if (!ok.ok) throw new Error(`Sandbox driver "${this.o.driver.name}" unavailable: ${ok.reason}`);
    if (!this.o.driver.multiTenantSafe) this.log(`WARNING: driver "${this.o.driver.name}" shares the host kernel. Use it for development or single-tenant pools only.`);
    installFirewall(this.o.egressPort ?? EGRESS_PORT);
    await this.egress.listen(this.o.egressPort ?? EGRESS_PORT);
    // Sessions that were running when the control plane stopped are asleep now.
    for (const s of Object.values(this.store.sessions)) if (s.status === 'running' || s.status === 'starting') s.status = 'sleeping';
    this.store.save();
    await this.fillPool();
    this.sweeper = setInterval(() => void this.sweep(), 5000);
    this.sweeper.unref();
  }

  async shutdown() {
    clearInterval(this.sweeper);
    for (const id of [...this.live.keys()]) await this.sleep(id).catch(() => {});
    for (const p of this.pool.splice(0)) {
      await p.sb.destroy();
      this.freeSlots.push(p.slot);
    }
    await this.egress.close();
  }

  // ---------- tenants ----------

  tenant(id: string): Tenant {
    const t = this.store.tenants[id];
    if (!t) throw new CloudError(`No tenant "${id}"`, 404);
    return t;
  }

  // ---------- sandboxes ----------

  private mounts(): MountSpec[] {
    const p = this.o.platform;
    const m: MountSpec[] = [
      { host: p.nodeDir, sandbox: p.nodeDir },
      { host: join(p.stagecraftDir, 'packages'), sandbox: '/opt/stagecraft/packages' },
      { host: join(p.stagecraftDir, 'node_modules'), sandbox: '/opt/stagecraft/node_modules' },
      { host: join(p.stagecraftDir, 'package.json'), sandbox: '/opt/stagecraft/package.json' },
    ];
    if (p.caFile) m.push({ host: p.caFile, sandbox: '/opt/stagecraft/ca.crt' });
    return m;
  }

  private baseEnv(hostIp: string): Record<string, string> {
    const proxy = `http://${hostIp}:${this.o.egressPort ?? EGRESS_PORT}`;
    return {
      PATH: `/workspace/node_modules/.bin:/opt/stagecraft/node_modules/.bin:${this.o.platform.nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      npm_config_cache: '/tmp/.npm',
      CI: '1',
      ...(this.o.platform.caFile ? { NODE_EXTRA_CA_CERTS: '/opt/stagecraft/ca.crt', npm_config_cafile: '/opt/stagecraft/ca.crt', GIT_SSL_CAINFO: '/opt/stagecraft/ca.crt' } : {}),
    };
  }

  private takeSlot(): number {
    const s = this.freeSlots.shift();
    if (s === undefined) throw new CloudError('No sandbox capacity left on this host', 503);
    return s;
  }

  private async newSandbox(id: string, workspaceRef: { dir: string }, policy = DEFAULT_POLICY): Promise<{ sb: Sandbox; slot: number }> {
    const slot = this.takeSlot();
    const spec = { id, slot, limits: { memoryMb: policy.memoryMb, cpuPercent: policy.cpuPercent, pids: policy.pids }, workspace: workspaceRef.dir, mounts: this.mounts(), env: {} as Record<string, string> };
    // The workspace folder is chosen at claim time for pooled sandboxes.
    Object.defineProperty(spec, 'workspace', { get: () => workspaceRef.dir, enumerable: true });
    const sb = await this.o.driver.create(spec);
    spec.env = this.baseEnv(sb.hostIp);
    return { sb, slot };
  }

  /** Warm pool: sandboxes created ahead (network, cgroups), bound to a workspace on claim. */
  private async fillPool() {
    const want = this.o.warmPool ?? 0;
    while (this.pool.length < want && this.freeSlots.length) {
      const id = randomId('sb');
      const ref = { dir: '/nonexistent' };
      const { sb, slot } = await this.newSandbox(id, ref);
      this.pool.push({ sb, slot, id, workspaceRef: ref });
    }
  }

  private async claim(dir: string, policy: typeof DEFAULT_POLICY) {
    const p = this.pool.find(() => policy.memoryMb === DEFAULT_POLICY.memoryMb && policy.cpuPercent === DEFAULT_POLICY.cpuPercent && policy.pids === DEFAULT_POLICY.pids);
    if (p) {
      this.pool.splice(this.pool.indexOf(p), 1);
      p.workspaceRef.dir = dir;
      void this.fillPool();
      return { sb: p.sb, slot: p.slot, warm: true };
    }
    const ref = { dir };
    const { sb, slot } = await this.newSandbox(randomId('sb'), ref, policy);
    return { sb, slot, warm: false };
  }

  // ---------- workspaces and snapshots (FR-107) ----------

  async buildWorkspace(tenantId: string, repoUrl: string, ref = 'HEAD', opts: { gitToken?: string; installTimeoutMs?: number } = {}): Promise<Workspace> {
    const t = this.tenant(tenantId);
    const ws: Workspace = { id: randomId('ws'), tenant: t.id, repoUrl, ref, status: 'building', createdAt: new Date().toISOString() };
    this.store.workspaces[ws.id] = ws;
    this.store.save();
    const t0 = Date.now();
    const dir = join(this.o.dataDir, 'build', ws.id);
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, '..'), { recursive: true });
      const url = opts.gitToken && repoUrl.startsWith('https://') ? repoUrl.replace('https://', `https://x-access-token:${opts.gitToken}@`) : repoUrl;
      git(join(dir, '..'), 'clone', '--quiet', url, dir);
      if (ref !== 'HEAD') git(dir, 'checkout', '--quiet', ref);
      // Never keep the token in the snapshot.
      git(dir, 'remote', 'set-url', 'origin', repoUrl);
      ws.commit = git(dir, 'rev-parse', 'HEAD');
      ws.lockHash = lockHash(dir);
      const key = this.snapshots.key(t.id, repoUrl, ws.lockHash);
      if (!this.snapshots.has(key)) {
        const cmd = installCommand(dir);
        if (cmd) {
          // Install scripts are untrusted code: they run in a sandbox with the tenant's egress rules.
          const { sb, slot } = await this.newSandbox(randomId('bld'), { dir }, t.policy);
          this.egress.register(sb.ip, t.id, t.policy.egressAllow);
          try {
            const r = await collect(sb.exec(cmd), opts.installTimeoutMs ?? 10 * 60_000);
            if (r.code !== 0) throw new CloudError(`Dependency install failed (${cmd.join(' ')}):\n${r.out.slice(-3000)}`, 422);
          } finally {
            this.egress.unregister(sb.ip);
            await sb.destroy();
            this.freeSlots.push(slot);
          }
        }
        this.snapshots.create(dir, key);
      }
      ws.snapshot = key;
      ws.status = 'ready';
      ws.buildMs = Date.now() - t0;
    } catch (e) {
      ws.status = 'failed';
      ws.error = (e as Error).message.slice(0, 4000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      this.store.save();
      this.store.audit(`${t.id}:api`, 'workspace.build', ws.id, { status: ws.status, ms: Date.now() - t0 });
    }
    if (ws.status === 'failed') throw new CloudError(ws.error ?? 'build failed', 422);
    return ws;
  }

  // ---------- usage and policy (FR-1503..1505, FR-205) ----------

  minutesThisMonth(tenantId: string): number {
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    let ms = 0;
    for (const u of this.store.usage) {
      if (u.tenant !== tenantId) continue;
      const s = Math.max(u.start, monthStart);
      const e = u.end ?? Date.now();
      if (e > s) ms += e - s;
    }
    return ms / 60000;
  }

  private checkPolicy(t: Tenant) {
    if (!t.policy.cloud) throw new CloudError('Cloud sandboxes are turned off for this organization (strict mode). Use the local runtime.', 403);
    const cap = t.policy.monthlyMinutesCap;
    if (cap > 0) {
      const used = this.minutesThisMonth(t.id);
      if (used >= cap) throw new CloudError(`Monthly sandbox limit reached (${Math.round(used)} of ${cap} minutes). Running sessions continue; new ones start next month or after the admin raises the cap.`, 402);
      if (used >= cap * 0.8) this.store.audit(`${t.id}:system`, 'spend.alert', t.id, { level: '80%', used, cap });
    }
  }

  private openUsage(s: SessionRec) {
    this.store.usage.push({ tenant: s.tenant, session: s.id, start: Date.now() });
  }
  private closeUsage(s: SessionRec) {
    const u = [...this.store.usage].reverse().find((x) => x.session === s.id && !x.end);
    if (u) u.end = Date.now();
  }

  // ---------- sessions ----------

  ownerLoginUrl(s: SessionRec): string {
    const t = signToken(this.o.edgeSecret, { sid: s.id, role: 'owner', login: true }, 600);
    return `${this.previewUrl(s)}/__edge/login?t=${encodeURIComponent(t)}`;
  }

  previewUrl(s: SessionRec): string {
    const port = this.o.previewPort && ![80, 443].includes(this.o.previewPort) ? `:${this.o.previewPort}` : '';
    return `${this.o.previewScheme ?? 'https'}://${s.id}.${this.o.previewDomain}${port}`;
  }

  /** Per-session secret the edge uses to sign owner requests (STAGECRAFT_EDGE_SECRET in the sandbox). */
  sessionEdgeSecret(sid: string) {
    return hmac(this.o.edgeSecret, `session:${sid}`);
  }

  sandboxTarget(sid: string): { ip: string; port: number } | null {
    const l = this.live.get(sid);
    return l ? { ip: l.sb.ip, port: STAGECRAFT_PORT } : null;
  }

  async startSession(tenantId: string, workspaceId: string, branch?: string): Promise<SessionRec> {
    const t = this.tenant(tenantId);
    const ws = this.store.workspaces[workspaceId];
    if (!ws || ws.tenant !== t.id) throw new CloudError(`No workspace "${workspaceId}"`, 404);
    if (ws.status !== 'ready' || !ws.snapshot) throw new CloudError(`Workspace is ${ws.status}`, 409);
    this.checkPolicy(t);
    const id = randomId('s', 8);
    const dir = join(this.o.dataDir, 'sessions', id);
    const s: SessionRec = { id, tenant: t.id, workspace: ws.id, branch: branch ?? `proto/${id}`, status: 'starting', dir };
    this.store.sessions[id] = s;
    this.store.save();
    const t0 = Date.now();
    this.snapshots.restore(ws.snapshot, join(dir, 'workspace'));
    const wdir = join(dir, 'workspace');
    try {
      git(wdir, 'checkout', '--quiet', '-B', s.branch);
    } catch {
      /* detached snapshots are fine */
    }
    await this.boot(s, t);
    s.startMs = Date.now() - t0;
    this.store.save();
    this.store.audit(`${t.id}:api`, 'session.start', s.id, { workspace: ws.id, ms: s.startMs });
    return s;
  }

  private async boot(s: SessionRec, t: Tenant) {
    const { sb, slot } = await this.claim(join(s.dir, 'workspace'), t.policy);
    this.egress.register(sb.ip, t.id, t.policy.egressAllow);
    const dev = sb.exec(['node', '/opt/stagecraft/packages/cli/src/bin.ts', 'dev', '--host', '0.0.0.0', '--port', String(STAGECRAFT_PORT), '--no-link'], { env: { STAGECRAFT_EDGE_SECRET: this.sessionEdgeSecret(s.id) } });
    let devOut = '';
    dev.stdout?.on('data', (d) => (devOut = (devOut + d).slice(-8000)));
    dev.stderr?.on('data', (d) => (devOut = (devOut + d).slice(-8000)));
    this.live.set(s.id, { sb, slot, dev });
    s.sandbox = sb.id;
    s.ip = sb.ip;
    const until = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < until && dev.exitCode === null) {
      const h = await fetch(`http://${sb.ip}:${STAGECRAFT_PORT}/__stagecraft/health`, { headers: { 'x-stagecraft-edge': this.ownerHeader(s.id) }, signal: AbortSignal.timeout(1500) }).catch(() => null);
      if (h?.ok && /Ready:/.test(devOut)) {
        ready = true;
        break;
      }
      await sleep(250);
    }
    if (!ready) {
      s.status = 'failed';
      s.error = `Stagecraft did not start in the sandbox:\n${devOut.slice(-3000)}`;
      await this.teardown(s.id);
      this.store.save();
      throw new CloudError(s.error, 500);
    }
    s.status = 'running';
    s.startedAt = new Date().toISOString();
    s.lastActiveAt = s.startedAt;
    this.openUsage(s);
    this.store.save();
  }

  /** Signed owner header for the sandbox's Stagecraft proxy (see server edgeOwner()). */
  ownerHeader(sid: string): string {
    const ts = Math.floor(Date.now() / 1000);
    return `${ts}.${hmac(this.sessionEdgeSecret(sid), `owner.${ts}`)}`;
  }

  touch(sid: string) {
    const s = this.store.sessions[sid];
    if (s && s.status === 'running') s.lastActiveAt = new Date().toISOString();
  }

  private async teardown(sid: string) {
    const l = this.live.get(sid);
    if (!l) return;
    this.live.delete(sid);
    this.egress.unregister(l.sb.ip);
    await l.sb.destroy();
    this.freeSlots.push(l.slot);
  }

  /** Sleep (FR-204): save sessions + mock DB; stop processes; keep the workspace on disk. */
  async sleep(sid: string) {
    const s = this.store.sessions[sid];
    if (!s || s.status !== 'running') return s;
    const l = this.live.get(sid);
    if (l) {
      const r = await fetch(`http://${l.sb.ip}:${STAGECRAFT_PORT}/__stagecraft/api/state/export`, { headers: { 'x-stagecraft-edge': this.ownerHeader(sid) }, signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (r?.ok) writeFileSync(join(s.dir, 'state.json'), await r.text(), { mode: 0o600 });
    }
    await this.teardown(sid);
    s.status = 'sleeping';
    this.closeUsage(s);
    this.store.save();
    this.store.audit(`${s.tenant}:system`, 'session.sleep', sid);
    return s;
  }

  private resuming = new Map<string, Promise<SessionRec>>();
  /** Resume: new sandbox on the same workspace, then restore sessions and mock DB. */
  resume(sid: string): Promise<SessionRec> {
    const s = this.store.sessions[sid];
    if (!s) return Promise.reject(new CloudError(`No session "${sid}"`, 404));
    if (s.status === 'running') return Promise.resolve(s);
    if (s.status === 'stopped') return Promise.reject(new CloudError('Session was stopped', 410));
    const existing = this.resuming.get(sid);
    if (existing) return existing;
    const p = (async () => {
      const t = this.tenant(s.tenant);
      this.checkPolicy(t);
      const t0 = Date.now();
      s.status = 'starting';
      await this.boot(s, t);
      const f = join(s.dir, 'state.json');
      if (existsSync(f)) {
        await fetch(`http://${s.ip}:${STAGECRAFT_PORT}/__stagecraft/api/state/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stagecraft-edge': this.ownerHeader(sid) }, body: readFileSync(f, 'utf8') }).catch(() => null);
      }
      s.startMs = Date.now() - t0;
      this.store.save();
      this.store.audit(`${s.tenant}:system`, 'session.resume', sid, { ms: s.startMs });
      return s;
    })().finally(() => this.resuming.delete(sid));
    this.resuming.set(sid, p);
    return p;
  }

  /** Stop: end the session and delete its copy of the code (NFR-104). */
  async stop(sid: string) {
    const s = this.store.sessions[sid];
    if (!s) throw new CloudError(`No session "${sid}"`, 404);
    await this.teardown(sid);
    rmSync(s.dir, { recursive: true, force: true });
    if (s.status === 'running') this.closeUsage(s);
    s.status = 'stopped';
    this.store.save();
    this.store.audit(`${s.tenant}:api`, 'session.stop', sid);
    return s;
  }

  /** Idle sleep and wall-clock cap. */
  async sweep() {
    const now = Date.now();
    for (const s of Object.values(this.store.sessions)) {
      if (s.status !== 'running') continue;
      const p = this.tenant(s.tenant).policy;
      if (s.startedAt && now - Date.parse(s.startedAt) > p.maxSessionSec * 1000) {
        this.log(`session ${s.id} hit the wall-clock cap`);
        await this.sleep(s.id);
      } else if (s.lastActiveAt && now - Date.parse(s.lastActiveAt) > p.idleTimeoutSec * 1000) {
        await this.sleep(s.id);
      }
    }
  }

  /**
   * Run the tenant's agent CLI in the session's sandbox (FR-307). The API key is decrypted from
   * the tenant secret store and given only to this process's environment (6.3 step 4).
   */
  async runAgent(sid: string, input: { command: string[]; secretName?: string; secretEnv?: string; timeoutMs?: number }) {
    const s = this.store.sessions[sid];
    const l = s && this.live.get(sid);
    if (!s || !l) throw new CloudError('Session is not running', 409);
    const t = this.tenant(s.tenant);
    const secretEnv: Record<string, string> = {};
    if (input.secretName) {
      const v = this.store.getSecret(t, input.secretName);
      if (!v) throw new CloudError(`No secret "${input.secretName}"`, 404);
      secretEnv[input.secretEnv ?? input.secretName] = v;
    }
    this.touch(sid);
    this.store.audit(`${t.id}:api`, 'agent.run', sid, { command: input.command[0], secret: input.secretName });
    const r = await collect(l.sb.exec(input.command, { secretEnv, env: { STAGECRAFT_URL: `http://127.0.0.1:${STAGECRAFT_PORT}` } }), input.timeoutMs ?? 30 * 60_000);
    // Never echo the secret back.
    let out = r.out;
    for (const v of Object.values(secretEnv)) if (v.length >= 6) out = out.split(v).join('[secret]');
    return { exitCode: r.code, output: out };
  }

  stats(sid: string) {
    return this.live.get(sid)?.sb.stats() ?? null;
  }
}
