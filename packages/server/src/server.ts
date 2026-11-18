import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { decodeShareState, encodeShareState, validateTape, type Json, type MockReply, type SessionState } from '@stagecraft/core';
import { Engine, UserError, type PatchInput, type Session } from './engine.ts';
import { compile, matchRoute } from './routes.ts';
import type { TapeClient } from './tape-player.ts';
import { comparePage } from './compare.ts';
import { resolveWorkspace } from './workspace.ts';

export const SESSION_HEADER = 'x-stagecraft-session';
const ONE_SHOT_PARAMS = ['sc_scenario', 'sc_tape', 'sc_step', 'sc_play', 'sc_panel'];

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Override the dev server URL from config. */
  devUrl?: string;
  /** Route workspace app mounts (default true). Port-mounted app servers pass false. */
  mounts?: boolean;
  log?: (m: string) => void;
  watch?: boolean;
  tapeSpeed?: number;
}

function runtimeBundle(): string {
  let file: string;
  try {
    file = fileURLToPath(import.meta.resolve('@stagecraft/runtime/runtime.js'));
  } catch {
    file = createRequire(import.meta.url).resolve('@stagecraft/runtime/runtime.js');
  }
  if (!existsSync(file)) throw new Error(`Runtime bundle missing at ${file}. Run "npm run build".`);
  return readFileSync(file, 'utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new UserError('Body must be JSON');
  }
}

function isReply(v: unknown): v is MockReply {
  return typeof v === 'object' && v !== null && (v as MockReply).__stagecraftReply === true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StagecraftServer {
  engine: Engine;
  server: http.Server;
  private wss = new WebSocketServer({ noServer: true });
  private devUrl!: URL;
  private opts: ServerOptions;
  private watchers: FSWatcher[] = [];
  private runtimeJs: string | null = null;
  log: (m: string) => void;

  constructor(engine: Engine, opts: ServerOptions = {}) {
    this.engine = engine;
    this.opts = opts;
    this.log = opts.log ?? engine.log;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        const status = err instanceof UserError ? err.status : 500;
        if (status === 500) this.log(`Error on ${req.method} ${req.url}: ${(err as Error).stack}`);
        if (!res.headersSent) sendJson(res, status, { error: (err as Error).message });
        else res.end();
      });
    });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as net.Socket, head));
  }

  async listen(): Promise<{ url: string; port: number }> {
    this.devUrl = new URL(this.opts.devUrl ?? this.engine.config.devUrl);
    const port = this.opts.port ?? this.engine.config.port;
    const host = this.opts.host ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve());
    });
    const actual = (this.server.address() as net.AddressInfo).port;
    if (this.opts.watch !== false) this.startWatch();
    return { url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`, port: actual };
  }

  async close() {
    for (const w of this.watchers) w.close();
    for (const s of this.engine.sessions.values()) this.engine.stopTape(s);
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Reload mocks, scenarios and tapes when files change, so agent edits apply without a restart. */
  private startWatch() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.engine
          .reload()
          .then(() => this.log('Reloaded config, mocks, scenarios and tapes'))
          .catch((e) => this.log(`Reload failed: ${(e as Error).message}`));
      }, 150);
    };
    for (const dir of [this.engine.root + '/stagecraft']) {
      if (!existsSync(dir)) continue;
      try {
        this.watchers.push(watch(dir, { recursive: true }, kick));
      } catch {
        /* recursive watch unsupported: skip */
      }
    }
    try {
      this.watchers.push(watch(this.engine.loaded.file, kick));
    } catch {
      /* ignore */
    }
  }

  /**
   * Session for a request: header (runtime) > `__sc_sid` query (EventSource, WebSocket) >
   * `__sc_session` in the Referer (full page navigations and assets inside a forked tab or frame) > main.
   * No cookies on purpose: compare frames are separate sessions in one browser.
   */
  /** Dev server for a path: a workspace app mounted on a prefix, else the host app. */
  upstreamFor(path: string): URL {
    if (this.opts.mounts === false) return this.devUrl;
    let best: { prefix: string; url: string } | null = null;
    for (const r of resolveWorkspace(this.engine.root, this.engine.config)) {
      if (r.role !== 'app' || !r.mount || !r.devUrl) continue;
      const prefix = r.mount.replace(/\/$/, '');
      if ((path === prefix || path.startsWith(prefix + '/')) && (!best || prefix.length > best.prefix.length)) best = { prefix, url: r.devUrl };
    }
    return best ? new URL(best.url) : this.devUrl;
  }

  sessionFor(req: IncomingMessage, url: URL): Session {
    let id = (req.headers[SESSION_HEADER] as string | undefined) ?? url.searchParams.get('__sc_sid') ?? undefined;
    if (!id && req.headers.referer) {
      try {
        const ref = new URL(req.headers.referer);
        const fromRef = ref.searchParams.get('__sc_session');
        if (fromRef && !fromRef.startsWith('fork') && this.engine.hasSession(fromRef)) id = fromRef;
      } catch {
        /* bad referer */
      }
    }
    return this.engine.getSession(id ?? 'main');
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    if (path === '/__stagecraft/runtime.js') {
      this.runtimeJs ??= runtimeBundle();
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(this.runtimeJs);
    }
    if (path === '/__stagecraft/health') return sendJson(res, 200, { ok: true, devUrl: this.devUrl.href });
    if (path === '/__stagecraft/compare') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(comparePage(url));
    }
    if (path.startsWith('/__stagecraft/api/')) return this.api(req, res, url, path.slice('/__stagecraft/api'.length));
    if (path.startsWith('/__stagecraft/mock/')) {
      // /__stagecraft/mock/<encoded origin>/<path>
      const rest = path.slice('/__stagecraft/mock/'.length);
      const slash = rest.indexOf('/');
      const mockPath = slash === -1 ? '/' : rest.slice(slash);
      return this.mock(req, res, url, mockPath);
    }
    if (this.engine.config.apiOrigins.some((o) => o.startsWith('/') && (path === o || path.startsWith(o.endsWith('/') ? o : o + '/')))) {
      return this.mock(req, res, url, path);
    }
    return this.proxy(req, res, url);
  }

  // ---------------- mocks ----------------

  private async mock(req: IncomingMessage, res: ServerResponse, url: URL, path: string) {
    const engine = this.engine;
    const s = this.sessionFor(req, url);
    const method = (req.method ?? 'GET').toUpperCase();
    const tapeCfg = engine.config.tapes;
    if (tapeCfg && (tapeCfg.transport ?? 'sse') === 'sse' && matchRoute([compile(tapeCfg.endpoint, 1)], method, path)) {
      return this.tapeSse(req, res, s);
    }
    const fault = s.state.faults.find((f) => matchRoute([compile(f.endpoint.includes(' ') ? f.endpoint : `* ${f.endpoint}`, 1)], method, path));
    if (fault) {
      if (fault.latencyMs) await sleep(fault.latencyMs);
      if (fault.timeout) {
        // Never answer. The client hits its own timeout.
        req.on('close', () => res.destroy());
        return;
      }
      if (fault.status) return sendJson(res, fault.status, fault.body ?? { error: `Injected fault ${fault.status}` }, { 'x-stagecraft-fault': '1' });
    }
    const m = matchRoute(engine.routes, method, path);
    if (!m) {
      const key = `${method} ${path}`;
      engine.unmocked.set(key, (engine.unmocked.get(key) ?? 0) + 1);
      if ((engine.unmocked.get(key) ?? 0) === 1) this.log(`No mock for ${key}. Add a handler in stagecraft/mocks.ts. (Never forwarded to a real backend.)`);
      return sendJson(res, engine.config.unmocked === 'error' ? 501 : 404, { error: `stagecraft: no mock for ${key}` }, { 'x-stagecraft-unmocked': '1' });
    }
    const raw = await readBody(req);
    let body: unknown = raw;
    if (raw && /json/.test(String(req.headers['content-type'] ?? ''))) {
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep raw */
      }
    }
    const persona = engine.config.personas[s.state.persona]!;
    const ctx = {
      db: s.dbRef.db,
      params: m.params,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers,
      method,
      path,
      persona: { ...persona, id: s.state.persona },
      flags: engine.effectiveFlags(s),
      states: s.state.states,
      reply: (status: number, b?: unknown, headers?: Record<string, string>): MockReply => ({ __stagecraftReply: true, status, body: b, headers }),
    };
    let out: unknown;
    try {
      out = await m.route.value(ctx);
    } catch (err) {
      this.log(`Mock handler "${m.route.key}" threw: ${(err as Error).stack}`);
      return sendJson(res, 500, { error: `stagecraft: mock handler "${m.route.key}" threw: ${(err as Error).message}` });
    }
    if (method !== 'GET' && method !== 'HEAD') engine.dbChanged(s);
    const headers = { 'x-stagecraft-mock': m.route.key };
    if (isReply(out)) return sendJson(res, out.status, out.body, { ...headers, ...out.headers });
    if (out === undefined) {
      res.writeHead(204, headers);
      return res.end();
    }
    return sendJson(res, 200, out, headers);
  }

  private tapeSse(req: IncomingMessage, res: ServerResponse, s: Session) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    let open = true;
    const client: TapeClient = {
      send: (e) => {
        // Plain "message" events: a named "error" event would collide with EventSource's own error event.
        if (open) res.write(`data: ${JSON.stringify(e)}\n\n`);
      },
      close: () => {
        open = false;
        res.end();
      },
    };
    const player = s.player;
    req.on('close', () => {
      open = false;
      player?.detach(client);
    });
    if (player) player.attach(client);
    else client.send({ type: 'hello', tape: null });
  }

  private upgrade(req: IncomingMessage, socket: net.Socket, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://local');
    const tapeCfg = this.engine.config.tapes;
    if (tapeCfg?.transport === 'websocket' && matchRoute([compile(tapeCfg.endpoint.replace(/^\S+/, '*'), 1)], 'GET', url.pathname)) {
      const s = this.sessionFor(req, url);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const client: TapeClient = {
          send: (e) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(e)),
          close: () => ws.close(),
        };
        const player = s.player;
        ws.on('close', () => player?.detach(client));
        if (player) player.attach(client);
        else client.send({ type: 'hello', tape: null });
      });
      return;
    }
    // Pass everything else (HMR) through to the dev server.
    const up = this.upstreamFor(url.pathname);
    const target = net.connect(Number(up.port || 80), up.hostname, () => {
      // Dev servers (Next.js) check Host and Origin on the HMR socket: present ourselves as same-origin.
      const fwd: Record<string, string | string[] | undefined> = { ...req.headers, host: up.host };
      if (fwd.origin) fwd.origin = up.origin;
      const headers = Object.entries(fwd)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
        .join('\r\n');
      target.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    const kill = () => {
      socket.destroy();
      target.destroy();
    };
    target.on('error', kill);
    socket.on('error', kill);
  }

  // ---------------- proxy + injection ----------------

  /** Apply link params on a document request, before the HTML is built. */
  private applyDocumentParams(req: IncomingMessage, url: URL): { session: Session; panel: boolean } {
    const e = this.engine;
    const sp = url.searchParams;
    let s: Session;
    const want = sp.get('__sc_session');
    if (want === 'fork' || want?.startsWith('fork:')) s = e.fork(want.split(':')[1] ?? 'main');
    else if (want && !e.hasSession(want)) s = e.fork('main');
    else s = want ? e.getSession(want) : this.sessionFor(req, url);
    const scenario = sp.get('sc_scenario');
    if (scenario) e.loadScenario(s, scenario);
    const share = sp.get('__sc');
    if (share !== null) e.patch(s, this.fullPatchFromShare(share));
    const tape = sp.get('sc_tape');
    if (tape) e.loadTape(s, tape, sp.get('sc_step') ?? undefined, sp.get('sc_play') === '1' || !sp.get('sc_step'));
    return { session: s, panel: sp.get('sc_panel') !== '0' };
  }

  /** A link describes the whole state. Missing fields mean "default". */
  fullPatchFromShare(param: string): PatchInput {
    const e = this.engine;
    const d = e.defaultState();
    const sh = decodeShareState(param);
    const flags: Record<string, Json | null> = {};
    for (const k of Object.keys(e.config.flags ?? {})) flags[k] = sh.f?.[k] ?? null;
    const variants: Record<string, string | null> = {};
    for (const k of e.variantsSeen.keys()) variants[k] = null;
    Object.assign(variants, sh.v ?? {});
    return { persona: sh.p ?? d.persona, states: { ...d.states, ...(sh.s ?? {}) }, flags, variants, faults: sh.x ?? [], theme: sh.t };
  }

  shareParam(s: SessionState) {
    const d = this.engine.defaultState();
    return encodeShareState(s, d);
  }

  private bootScript(s: Session, panel: boolean) {
    const boot = {
      session: this.engine.sessionInfo(s),
      catalog: this.engine.catalog(),
      defaults: this.engine.defaultState(),
      panel,
      strip: ONE_SHOT_PARAMS,
    };
    const json = JSON.stringify(boot).replace(/</g, '\\u003c');
    return `<script>window.__STAGECRAFT_BOOT__=${json};</script><script src="/__stagecraft/runtime.js"></script>`;
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, url: URL) {
    const isDoc = req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''));
    let doc: { session: Session; panel: boolean } | null = null;
    if (isDoc) doc = this.applyDocumentParams(req, url);
    // Tell the dev server which session this request belongs to, so server-side fetches
    // (SSR, React Server Components) read the same mock DB as the browser (see preload.mjs).
    const sid = doc ? doc.session.id : this.sessionFor(req, url).id;
    const up = this.upstreamFor(url.pathname);
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: up.host, [SESSION_HEADER]: sid };
    // Same reason as for upgrades: dev servers block cross-origin requests to their dev endpoints.
    if (headers.origin) headers.origin = up.origin;
    if (isDoc) headers['accept-encoding'] = 'identity';
    const upstream = http.request(
      { hostname: up.hostname, port: up.port || 80, path: req.url, method: req.method, headers },
      (up) => {
        const type = String(up.headers['content-type'] ?? '');
        if (!doc || !type.includes('text/html')) {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          // Dev only: drop CSP so the overlay can load (FR-104).
          html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
          const inject = this.bootScript(doc!.session, doc!.panel);
          html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + html;
          const h = { ...up.headers };
          delete h['content-length'];
          delete h['transfer-encoding'];
          delete h['content-security-policy'];
          delete h['content-security-policy-report-only'];
          delete h['etag'];
          res.writeHead(up.statusCode ?? 200, { ...h, 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' });
          res.end(html);
        });
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><title>Stagecraft: dev server not reachable</title><body style="font:16px system-ui;padding:40px"><h1>Dev server not reachable</h1><p>Stagecraft could not reach <code>${up.href}</code>: ${err.message}.</p><p>Start it, or check <code>devUrl</code> in stagecraft.config.ts. This page retries in 2 s.</p><script>setTimeout(()=>location.reload(),2000)</script>`,
        );
      } else res.end();
    });
    req.pipe(upstream);
  }

  // ---------------- control API ----------------

  private async api(req: IncomingMessage, res: ServerResponse, url: URL, route: string) {
    const e = this.engine;
    const s = this.sessionFor(req, url);
    const method = req.method ?? 'GET';
    const key = `${method} ${route}`;
    switch (key) {
      case 'GET /boot':
        return sendJson(res, 200, { session: e.sessionInfo(s), catalog: e.catalog(), defaults: e.defaultState() });
      case 'GET /catalog':
        return sendJson(res, 200, e.catalog());
      case 'GET /session':
        return sendJson(res, 200, { ...e.sessionInfo(s), link: this.link(s, url) });
      case 'PATCH /session': {
        const body = (await readJson(req)) as PatchInput;
        e.patch(s, body);
        return sendJson(res, 200, e.sessionInfo(s));
      }
      case 'GET /events':
        return this.events(req, res, s);
      case 'POST /navigate': {
        const { url: to } = await readJson(req);
        if (typeof to !== 'string' || !to.startsWith('/')) throw new UserError('url must be a path that starts with "/"');
        e.emit(s, { type: 'navigate', url: to });
        return sendJson(res, 200, { ok: true, listeners: s.listeners.size });
      }
      case 'POST /variants/register': {
        const { name, options } = await readJson(req);
        if (typeof name !== 'string' || !Array.isArray(options)) throw new UserError('name and options[] required');
        const prev = e.variantsSeen.get(name);
        e.variantsSeen.set(name, options.map(String));
        return sendJson(res, 200, { ok: true, new: !prev });
      }
      case 'GET /scenarios':
        return sendJson(res, 200, e.listScenarios());
      case 'POST /scenarios': {
        const body = await readJson(req);
        const out = e.saveScenario(s, body);
        return sendJson(res, 200, { file: out.file, name: out.scenario.name });
      }
      case 'POST /scenarios/load': {
        const { name } = await readJson(req);
        const out = e.loadScenario(s, String(name));
        return sendJson(res, 200, { ...out, session: e.sessionInfo(s) });
      }
      case 'GET /mockdb':
        return sendJson(res, 200, { path: url.searchParams.get('path') ?? '', value: e.queryDb(s, url.searchParams.get('path') ?? undefined) ?? null });
      case 'POST /mockdb/seed': {
        const body = await readJson(req);
        e.seedDb(s, body);
        return sendJson(res, 200, { ok: true });
      }
      case 'POST /mockdb/reset':
        e.resetDb(s);
        return sendJson(res, 200, { ok: true });
      case 'GET /endpoints':
        return sendJson(res, 200, {
          handlers: e.routes.map((r) => r.key),
          tapeEndpoint: e.config.tapes?.endpoint ?? null,
          unmocked: [...e.unmocked].map(([k, n]) => ({ endpoint: k, count: n })),
          apiOrigins: e.config.apiOrigins,
        });
      case 'GET /tapes':
        return sendJson(res, 200, e.listTapes());
      case 'POST /tapes': {
        const body = await readJson(req);
        return sendJson(res, 200, e.saveTape(body.tape ?? body));
      }
      case 'POST /tapes/validate': {
        const body = await readJson(req);
        const issues = validateTape(body.tape ?? body);
        return sendJson(res, 200, { valid: issues.length === 0, issues });
      }
      case 'GET /tape':
        return sendJson(res, 200, s.player?.status() ?? null);
      case 'POST /tape/load': {
        const { id, at, autoplay } = await readJson(req);
        const st = e.loadTape(s, String(id), at === undefined || at === null ? undefined : String(at), autoplay);
        // The chat UI must reconnect to see the new tape: remount the app.
        e.emit(s, { type: 'state', reason: 'data', state: s.state, flags: e.effectiveFlags(s), dataVersion: ++s.dataVersion, uiVersion: s.uiVersion });
        return sendJson(res, 200, st);
      }
      case 'POST /tape/control': {
        const { action } = await readJson(req);
        if (action === 'stop') {
          e.stopTape(s);
          return sendJson(res, 200, null);
        }
        if (!s.player) throw new UserError('No tape loaded. Call tape load first.', 409);
        if (action === 'play') s.player.play();
        else if (action === 'pause') s.player.pause();
        else if (action === 'step') await s.player.stepOnce();
        else throw new UserError('action must be play, pause, step or stop');
        return sendJson(res, 200, s.player.status());
      }
      case 'POST /reload':
        await e.reload();
        return sendJson(res, 200, { ok: true });
      case 'GET /link':
        return sendJson(res, 200, { url: this.link(s, url) });
      default:
        throw new UserError(`No Stagecraft API route ${key}`, 404);
    }
  }

  private link(s: Session, url: URL) {
    const path = url.searchParams.get('path') ?? '/';
    const u = new URL(path, 'http://x');
    const sc = this.shareParam(s.state);
    if (sc) u.searchParams.set('__sc', sc);
    return u.pathname + u.search;
  }

  private events(req: IncomingMessage, res: ServerResponse, s: Session) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.flushHeaders();
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: 'hello', session: this.engine.sessionInfo(s) });
    s.listeners.add(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      s.listeners.delete(send);
    });
  }
}

export async function startServer(configFile: string, opts: ServerOptions = {}) {
  const engine = await new Engine(configFile, { log: opts.log, tapeSpeed: opts.tapeSpeed }).init();
  const server = new StagecraftServer(engine, opts);
  const { url, port } = await server.listen();
  // Workspace apps that cannot run under a path prefix get their own port, on the same engine
  // (same sessions and mock DB).
  const apps: { name: string; url: string; server: StagecraftServer }[] = [];
  for (const r of resolveWorkspace(engine.root, engine.config)) {
    if (r.role !== 'app' || r.host || r.port === undefined || !r.devUrl) continue;
    const s = new StagecraftServer(engine, { ...opts, port: r.port, devUrl: r.devUrl, mounts: false, watch: false });
    apps.push({ name: r.name, url: (await s.listen()).url, server: s });
  }
  const close = server.close.bind(server);
  server.close = async () => {
    await Promise.all(apps.map((a) => a.server.close()));
    await close();
  };
  return { engine, server, url, port, apps };
}
