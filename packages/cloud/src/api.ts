import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type net from 'node:net';
import { checkToken, hashToken, safeEqual } from './crypto.ts';
import { CloudError, type Orchestrator } from './orchestrator.ts';
import type { Policy, Tenant } from './store.ts';

type Role = 'admin' | 'builder';
interface Caller {
  tenant: Tenant | null;
  role: Role | 'platform';
  tokenId: string;
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CloudError('Body must be JSON');
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const POLICY_KEYS: (keyof Policy)[] = ['cloud', 'egressAllow', 'monthlyMinutesCap', 'idleTimeoutSec', 'maxSessionSec', 'memoryMb', 'cpuPercent', 'pids'];

/**
 * Control-plane API. Bearer tokens: one platform admin token (STAGECRAFT_ADMIN_TOKEN) creates
 * tenants; tenant tokens are stored as scrypt hashes and carry a role (admin | builder).
 * A tenant only ever sees its own workspaces and sessions (others → 404).
 */
export class Api {
  server: http.Server;
  private orch: Orchestrator;
  private adminToken: string;

  constructor(orch: Orchestrator, adminToken: string) {
    this.orch = orch;
    this.adminToken = adminToken;
    this.server = http.createServer((req, res) =>
      this.handle(req, res).catch((e) => {
        const status = e instanceof CloudError ? e.status : 500;
        if (status === 500) orch.log(`API error ${req.method} ${req.url}: ${(e as Error).stack}`);
        send(res, status, { error: (e as Error).message });
      }),
    );
  }

  listen(port: number, host = '127.0.0.1') {
    return new Promise<number>((r) => this.server.listen(port, host, () => r((this.server.address() as net.AddressInfo).port)));
  }
  close() {
    this.server.closeAllConnections?.();
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private auth(req: IncomingMessage): Caller {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m) throw new CloudError('Missing bearer token', 401);
    const token = m[1]!;
    if (safeEqual(token, this.adminToken)) return { tenant: null, role: 'platform', tokenId: 'platform' };
    const tm = /^sct_([a-z0-9-]+)_/.exec(token);
    const t = tm ? this.orch.store.tenants[tm[1]!] : undefined;
    const rec = t?.tokens.find((x) => checkToken(token, x));
    if (!t || !rec) throw new CloudError('Invalid token', 401);
    return { tenant: t, role: (rec.label.split(':')[0] as Role) ?? 'builder', tokenId: rec.id };
  }

  private issue(t: Tenant, role: Role, label: string) {
    const token = `sct_${t.id}_${randomBytes(24).toString('base64url')}`;
    const id = `tok${t.tokens.length + 1}`;
    t.tokens.push({ id, ...hashToken(token), label: `${role}:${label}`, createdAt: new Date().toISOString() });
    this.orch.store.save();
    return { id, token, role };
  }

  private sessionView(s: import('./store.ts').SessionRec, withLogin = false) {
    const { dir: _d, ip: _ip, ...pub } = s;
    return { ...pub, previewUrl: this.orch.previewUrl(s), ...(withLogin ? { ownerLoginUrl: this.orch.ownerLoginUrl(s) } : {}), stats: this.orch.stats(s.id) };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname.split('/').filter(Boolean);
    const m = req.method ?? 'GET';
    if (m === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    const c = this.auth(req);
    const st = this.orch.store;
    const actor = `${c.tenant?.id ?? 'platform'}:${c.tokenId}`;
    const needTenant = () => {
      if (!c.tenant) throw new CloudError('Use a tenant token', 403);
      return c.tenant;
    };
    const needAdmin = () => {
      const t = needTenant();
      if (c.role !== 'admin') throw new CloudError('Needs an admin token', 403);
      return t;
    };

    // POST /v1/tenants (platform)
    if (m === 'POST' && p[0] === 'v1' && p[1] === 'tenants' && p.length === 2) {
      if (c.role !== 'platform') throw new CloudError('Only the platform admin creates tenants', 403);
      const b = await body(req);
      if (!/^[a-z0-9-]{3,32}$/.test(b.id ?? '')) throw new CloudError('id: 3-32 chars, a-z 0-9 -');
      if (st.tenants[b.id]) throw new CloudError('Tenant exists', 409);
      const t = this.orch.store.newTenant(b.id, b.name ?? b.id);
      const tok = this.issue(t, 'admin', 'bootstrap');
      st.audit(actor, 'tenant.create', t.id);
      return send(res, 200, { tenant: t.id, adminToken: tok.token });
    }
    if (p[0] !== 'v1') throw new CloudError('Not found', 404);
    const r = `${m} /${p.slice(1).map((x, i) => (i > 0 && !['sleep', 'resume', 'agent'].includes(x) ? ':id' : x)).join('/')}`;
    switch (r) {
      case 'POST /tokens': {
        const t = needAdmin();
        const b = await body(req);
        const tok = this.issue(t, b.role === 'admin' ? 'admin' : 'builder', String(b.label ?? 'token'));
        st.audit(actor, 'token.create', t.id, { role: tok.role, label: b.label });
        return send(res, 200, tok);
      }
      case 'GET /policy':
        return send(res, 200, needTenant().policy);
      case 'PUT /policy': {
        const t = needAdmin();
        const b = await body(req);
        for (const k of Object.keys(b)) if (!POLICY_KEYS.includes(k as keyof Policy)) throw new CloudError(`Unknown policy field ${k}`);
        if (b.egressAllow && (!Array.isArray(b.egressAllow) || b.egressAllow.some((h: unknown) => typeof h !== 'string' || !/^\.?[a-z0-9.-]+$/.test(h)))) throw new CloudError('egressAllow: hostnames or .suffixes only');
        Object.assign(t.policy, b);
        st.save();
        st.audit(actor, 'policy.update', t.id, b);
        return send(res, 200, t.policy);
      }
      case 'PUT /secrets/:id': {
        const t = needAdmin();
        const b = await body(req);
        if (typeof b.value !== 'string' || !b.value) throw new CloudError('value required');
        st.setSecret(t, p[2]!, b.value);
        st.audit(actor, 'secret.set', `${t.id}/${p[2]}`);
        return send(res, 200, { name: p[2], set: true });
      }
      case 'GET /secrets':
        return send(res, 200, Object.keys(needTenant().secrets));
      case 'POST /workspaces': {
        const t = needTenant();
        const b = await body(req);
        if (typeof b.repoUrl !== 'string') throw new CloudError('repoUrl required');
        const ws = await this.orch.buildWorkspace(t.id, b.repoUrl, b.ref, { gitToken: b.gitTokenSecret ? st.getSecret(t, b.gitTokenSecret) : undefined });
        return send(res, 200, ws);
      }
      case 'GET /workspaces/:id': {
        const t = needTenant();
        const ws = st.workspaces[p[2]!];
        if (!ws || ws.tenant !== t.id) throw new CloudError('Not found', 404);
        return send(res, 200, ws);
      }
      case 'POST /sessions': {
        const t = needTenant();
        const b = await body(req);
        const s = await this.orch.startSession(t.id, String(b.workspace), b.branch);
        return send(res, 200, this.sessionView(s, true));
      }
      case 'GET /sessions/:id':
      case 'POST /sessions/:id/sleep':
      case 'POST /sessions/:id/resume':
      case 'POST /sessions/:id/login':
      case 'DELETE /sessions/:id':
      case 'POST /sessions/:id/agent': {
        const t = needTenant();
        const s = st.sessions[p[2]!];
        if (!s || s.tenant !== t.id) throw new CloudError('Not found', 404);
        if (r === 'GET /sessions/:id') return send(res, 200, this.sessionView(s));
        if (r === 'POST /sessions/:id/sleep') return send(res, 200, this.sessionView((await this.orch.sleep(s.id))!));
        if (r === 'POST /sessions/:id/resume') return send(res, 200, this.sessionView(await this.orch.resume(s.id)));
        if (r === 'POST /sessions/:id/login') return send(res, 200, { ownerLoginUrl: this.orch.ownerLoginUrl(s) });
        if (r === 'DELETE /sessions/:id') return send(res, 200, this.sessionView(await this.orch.stop(s.id)));
        const b = await body(req);
        if (!Array.isArray(b.command) || !b.command.every((x: unknown) => typeof x === 'string')) throw new CloudError('command: string[]');
        return send(res, 200, await this.orch.runAgent(s.id, { command: b.command, secretName: b.secret, secretEnv: b.secretEnv, timeoutMs: b.timeoutMs }));
      }
      case 'GET /usage': {
        const t = needTenant();
        return send(res, 200, { minutesThisMonth: Math.round(this.orch.minutesThisMonth(t.id) * 100) / 100, monthlyMinutesCap: t.policy.monthlyMinutesCap });
      }
      case 'GET /audit':
        return send(res, 200, st.auditLog(needAdmin().id));
      case 'GET /egress': {
        const t = needAdmin();
        return send(res, 200, this.orch.egress.decisions.filter((d) => d.tenant === t.id).slice(-200));
      }
    }
    throw new CloudError(`No route ${m} ${url.pathname}`, 404);
  }
}
