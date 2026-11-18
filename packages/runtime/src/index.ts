import { encodeShareState } from '@stagecraft/core';
import type { RuntimeEvent, SessionInfo, StagecraftRuntime } from './types.ts';
import { mountPanel } from './panel.ts';

(function main() {
  const boot = window.__STAGECRAFT_BOOT__;
  if (!boot || window.__STAGECRAFT__) return;
  let info: SessionInfo = boot.session;
  let catalog = boot.catalog;
  const defaults = boot.defaults;
  const sid: string = info.id;
  const SESSION_HEADER = 'x-stagecraft-session';
  const listeners = new Map<RuntimeEvent, Set<(d: any) => void>>();
  let adapter: string | null = null;
  const pendingVariants = new Map<string, string[]>();

  const emit = (e: RuntimeEvent, d?: any) => listeners.get(e)?.forEach((fn) => fn(d));

  // ---------- network routing ----------
  const here = location.origin;
  const fullOrigins: string[] = catalog.apiOrigins.filter((o: string) => !o.startsWith('/')).map((o: string) => new URL(o).origin);

  /** Returns the URL to use and whether to tag it with the session. */
  function route(input: string): { url: string; tag: boolean } {
    let u: URL;
    try {
      u = new URL(input, location.href);
    } catch {
      return { url: input, tag: false };
    }
    if (u.origin === here) {
      // Tag every same-origin request: server-rendered frameworks fetch data on the server
      // for page and RSC requests, and the proxy must know the session for those too.
      return { url: input, tag: true };
    }
    const wsToHttp = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    const origin = `${wsToHttp}//${u.host}`;
    if (fullOrigins.includes(origin)) {
      return { url: `${here}/__stagecraft/mock/${encodeURIComponent(origin)}${u.pathname}${u.search}`, tag: true };
    }
    return { url: input, tag: false };
  }

  function withSid(url: string) {
    if (sid === 'main') return url;
    const u = new URL(url, location.href);
    u.searchParams.set('__sc_sid', sid);
    return u.href;
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const raw = input instanceof Request ? input.url : String(input);
    const r = route(raw);
    if (!r.tag) return origFetch(input as RequestInfo, init);
    const req = new Request(input instanceof Request ? new Request(r.url, input) : r.url, init);
    if (sid !== 'main') req.headers.set(SESSION_HEADER, sid);
    return origFetch(req);
  };

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __sc?: boolean }, method: string, url: string | URL, ...rest: any[]) {
    const r = route(String(url));
    this.__sc = r.tag;
    return (XO as any).call(this, method, r.url, ...(rest.length ? rest : [true]));
  } as any;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __sc?: boolean }, body?: any) {
    if (this.__sc && sid !== 'main') this.setRequestHeader(SESSION_HEADER, sid);
    return XS.call(this, body);
  };

  const OrigES = window.EventSource;
  if (OrigES) {
    window.EventSource = class extends OrigES {
      constructor(url: string | URL, init?: EventSourceInit) {
        const r = route(String(url));
        super(r.tag ? withSid(r.url) : String(url), init);
      }
    } as typeof EventSource;
  }
  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      const r = route(String(url));
      let target = String(url);
      if (r.tag) {
        const u = new URL(withSid(r.url));
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        target = u.href;
      }
      super(target, protocols);
    }
  } as typeof WebSocket;

  // ---------- control API ----------
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await origFetch(`/__stagecraft/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sid },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  // ---------- URL: linkable state ----------
  function syncUrl() {
    try {
      const u = new URL(location.href);
      for (const p of boot.strip ?? []) u.searchParams.delete(p);
      u.searchParams.delete('__sc_sid');
      if (sid !== 'main') u.searchParams.set('__sc_session', sid);
      else u.searchParams.delete('__sc_session');
      const sc = encodeShareState(info.state, defaults);
      if (sc) u.searchParams.set('__sc', sc);
      else u.searchParams.delete('__sc');
      if (u.href !== location.href) history.replaceState(history.state, '', u.href);
    } catch {
      /* ignore */
    }
  }

  // Client routers (Next.js, React Router) rewrite the URL on navigation. Keep our params on it, so
  // links stay reproducible (FR-806) and later requests can find a forked session via the Referer.
  for (const fn of ['pushState', 'replaceState'] as const) {
    const orig = history[fn].bind(history);
    history[fn] = (data: any, unused: string, url?: string | URL | null) => {
      if (url !== undefined && url !== null) {
        try {
          const u = new URL(String(url), location.href);
          if (u.origin === location.origin) {
            const cur = new URL(location.href).searchParams;
            for (const k of ['__sc_session', '__sc']) {
              const v = cur.get(k);
              if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
            }
            url = u.pathname + u.search + u.hash;
          }
        } catch {
          /* leave url as is */
        }
      }
      return orig(data, unused, url);
    };
  }

  // ---------- events from the proxy ----------
  function connect() {
    const es = new OrigES(withSid(`/__stagecraft/api/events`));
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'hello') {
        info = e.session;
        return;
      }
      if (e.type === 'state') {
        const prevData = info.dataVersion;
        info = { ...info, state: e.state, flags: e.flags, dataVersion: e.dataVersion, uiVersion: e.uiVersion };
        syncUrl();
        if (e.reason === 'data' && e.dataVersion !== prevData) {
          if (adapter) emit('data', info);
          else location.reload();
        } else emit('ui', info);
      } else if (e.type === 'db') emit('db');
      else if (e.type === 'tape') {
        info = { ...info, tape: e.status };
        emit('tape', e.status);
      } else if (e.type === 'navigate') rt.navigate(e.url);
      else if (e.type === 'feedback') emit('feedback');
    };
  }

  let registerTimer: ReturnType<typeof setTimeout> | undefined;
  function flushVariants() {
    const batch = [...pendingVariants];
    pendingVariants.clear();
    for (const [name, options] of batch) {
      api('POST', '/variants/register', { name, options })
        .then(() => {
          catalog = { ...catalog, variants: { ...catalog.variants, [name]: options } };
          emit('catalog', catalog);
        })
        .catch(() => {});
    }
  }

  const rt: StagecraftRuntime = {
    get sessionId() {
      return sid;
    },
    get info() {
      return info;
    },
    get catalog() {
      return catalog;
    },
    flag(key, fallback) {
      return (key in info.flags ? info.flags[key] : fallback) as typeof fallback;
    },
    variant(name, options, fallback) {
      const known = catalog.variants?.[name] as string[] | undefined;
      if (!known || known.join('|') !== options.join('|')) {
        pendingVariants.set(name, options);
        clearTimeout(registerTimer);
        registerTimer = setTimeout(flushVariants, 50);
      }
      const v = info.state.variants[name];
      return v && options.includes(v) ? v : (fallback ?? options[0]!);
    },
    async set(patch) {
      info = await api<SessionInfo>('PATCH', '/session', patch);
      return info;
    },
    api,
    navigate(url) {
      const u = new URL(url, location.href);
      for (const [k, v] of new URL(location.href).searchParams) if (k.startsWith('__sc')) u.searchParams.set(k, v);
      history.pushState(history.state, '', u.pathname + u.search + u.hash);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      emit('navigate', url);
    },
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
    registerAdapter(name) {
      adapter = name;
    },
  };

  window.__STAGECRAFT__ = rt;
  syncUrl();
  connect();
  if (boot.panel !== false) {
    const start = () => mountPanel(rt, defaults);
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
