import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { signToken, verifyToken } from './crypto.ts';
import type { Orchestrator } from './orchestrator.ts';

export interface EdgeOptions {
  previewDomain: string;
  edgeSecret: string;
  /** Set Secure on cookies (true behind TLS). */
  secureCookies?: boolean;
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const WAKE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Waking up the preview…</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f6f4;color:#1b1b1b}@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}}
.bar{width:240px;height:6px;background:#ddd;border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;width:30%;background:#3b4ee8;animation:m 1.2s infinite ease-in-out}@keyframes m{0%{margin-left:-30%}100%{margin-left:100%}}@media (prefers-reduced-motion:reduce){.bar i{animation:none;width:100%}}</style></head>
<body><main><h1 style="font-size:18px">Waking up the preview…</h1><p role="status" id="s">Starting the sandbox. This takes a few seconds.</p><div class="bar" aria-hidden="true"><i></i></div></main>
<script>const go=async()=>{try{const r=await fetch('/__edge/status',{cache:'no-store'});const j=await r.json();document.getElementById('s').textContent=j.message;if(j.status==='running')return location.reload()}catch{}setTimeout(go,800)};go()</script></body></html>`;

/**
 * Preview edge: https://<session>.<previewDomain> → that session's Stagecraft proxy in its sandbox.
 * Owners log in once with a signed link and get a signed, HttpOnly cookie; their requests carry a
 * signed owner header. Everyone else reaches the sandbox as a remote client, where only share-link
 * viewer sessions work (enforced inside the sandbox). Client-sent edge headers are always removed.
 */
export class Edge {
  server: http.Server;
  private o: EdgeOptions;
  private orch: Orchestrator;

  constructor(orch: Orchestrator, o: EdgeOptions) {
    this.orch = orch;
    this.o = o;
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.fail(res, 500, (e as Error).message)));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as net.Socket, head));
  }

  listen(port: number, host = '0.0.0.0') {
    return new Promise<number>((r) => this.server.listen(port, host, () => r((this.server.address() as net.AddressInfo).port)));
  }
  close() {
    this.server.closeAllConnections?.();
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private sessionId(req: IncomingMessage): string | null {
    const host = String(req.headers.host ?? '').split(':')[0]!.toLowerCase();
    const suffix = `.${this.o.previewDomain.toLowerCase()}`;
    if (!host.endsWith(suffix)) return null;
    const id = host.slice(0, -suffix.length);
    return /^[a-z0-9]{4,40}$/.test(id) ? id : null;
  }

  private isOwner(req: IncomingMessage, sid: string): boolean {
    const t = verifyToken<{ sid: string; role: string }>(this.o.edgeSecret, cookies(req)[`sc_edge_${sid}`]);
    return !!t && t.sid === sid && t.role === 'owner';
  }

  private fail(res: ServerResponse, status: number, msg: string) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' });
    res.end(`<!doctype html><title>Preview</title><body style="font:16px system-ui;padding:40px"><h1>Preview not available</h1><p>${msg.replace(/</g, '&lt;')}</p>`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const sid = this.sessionId(req);
    if (!sid) return this.fail(res, 404, 'Unknown preview host.');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-robots-tag': 'noindex, nofollow' });
      return res.end('User-agent: *\nDisallow: /\n');
    }
    const s = this.orch.store.sessions[sid];
    if (!s || s.status === 'stopped') return this.fail(res, 404, 'This preview does not exist or has ended.');
    if (url.pathname === '/__edge/login') {
      const t = verifyToken<{ sid: string; role: string; login?: boolean }>(this.o.edgeSecret, url.searchParams.get('t') ?? undefined);
      if (!t || t.sid !== sid || !t.login) return this.fail(res, 401, 'This sign-in link is invalid or has expired. Get a new one from the API.');
      const c = signToken(this.o.edgeSecret, { sid, role: 'owner' }, 12 * 3600);
      res.writeHead(303, {
        location: '/',
        'set-cookie': `sc_edge_${sid}=${encodeURIComponent(c)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${this.o.secureCookies ? '; Secure' : ''}`,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      });
      return res.end();
    }
    if (url.pathname === '/__edge/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      const msg = s.status === 'running' ? 'Ready.' : s.status === 'failed' ? `The preview failed to start: ${s.error?.split('\n')[0] ?? ''}` : 'Starting the sandbox…';
      return res.end(JSON.stringify({ status: s.status, message: msg }));
    }
    if (s.status !== 'running') {
      // NFR-207: a link to a sleeping session wakes it and shows progress.
      if (s.status === 'sleeping') void this.orch.resume(sid).catch((e) => this.orch.log(`resume ${sid} failed: ${(e as Error).message}`));
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '2', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' });
      return res.end(WAKE_PAGE);
    }
    const target = this.orch.sandboxTarget(sid);
    if (!target) return this.fail(res, 503, 'The sandbox is not reachable.');
    this.orch.touch(sid);
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers['x-stagecraft-edge'];
    delete headers['x-stagecraft-test-remote'];
    if (this.isOwner(req, sid)) headers['x-stagecraft-edge'] = this.orch.ownerHeader(sid);
    headers['x-forwarded-host'] = req.headers.host;
    const up = http.request({ hostname: target.ip, port: target.port, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...r.headers, 'x-robots-tag': 'noindex, nofollow' });
      r.pipe(res);
    });
    up.on('error', () => this.fail(res, 502, 'The sandbox did not answer.'));
    req.pipe(up);
  }

  private upgrade(req: IncomingMessage, socket: net.Socket, head: Buffer) {
    const sid = this.sessionId(req);
    const s = sid ? this.orch.store.sessions[sid] : undefined;
    const target = sid ? this.orch.sandboxTarget(sid) : null;
    if (!sid || !s || s.status !== 'running' || !target) return socket.destroy();
    this.orch.touch(sid);
    const fwd: Record<string, string | string[] | undefined> = { ...req.headers };
    delete fwd['x-stagecraft-edge'];
    if (this.isOwner(req, sid)) fwd['x-stagecraft-edge'] = this.orch.ownerHeader(sid);
    const up = net.connect(target.port, target.ip, () => {
      const lines = Object.entries(fwd).filter(([, v]) => v !== undefined).map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`));
      up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const kill = () => {
      socket.destroy();
      up.destroy();
    };
    up.on('error', kill);
    socket.on('error', kill);
  }
}
