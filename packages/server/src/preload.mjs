// Stagecraft server-side interceptor (FR-501, SSR).
// Loaded with `node --import <this file>` (stagecraft dev sets NODE_OPTIONS for the dev server).
// Plain JS on purpose: Node cannot strip TypeScript types for files under node_modules.
//
// 1. Every incoming HTTP request runs in an AsyncLocalStorage context that holds the
//    Stagecraft session id (header x-stagecraft-session, set by the proxy).
// 2. Server-side fetch() calls to declared API origins go to the proxy's mock endpoint,
//    tagged with that session. So server components see the same mock DB as the browser.
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';

const PROXY = process.env.STAGECRAFT_PROXY;
const SESSION_HEADER = 'x-stagecraft-session';

if (PROXY && !globalThis.__stagecraftPreload) {
  globalThis.__stagecraftPreload = true;
  let origins = [];
  try {
    origins = JSON.parse(process.env.STAGECRAFT_API_ORIGINS || '[]');
  } catch {
    origins = [];
  }
  const fullOrigins = origins.filter((o) => !o.startsWith('/')).map((o) => new URL(o).origin);
  const proxyOrigin = new URL(PROXY).origin;
  const als = new AsyncLocalStorage();
  const warned = new Set();

  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, ...rest) {
    if (event === 'request' && req && req.headers) {
      const sid = req.headers[SESSION_HEADER];
      return als.run({ sid: typeof sid === 'string' ? sid : undefined }, () => origEmit.call(this, event, req, ...rest));
    }
    return origEmit.call(this, event, req, ...rest);
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = function stagecraftFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    } catch {
      return origFetch(input, init);
    }
    if (url.origin === proxyOrigin) {
      // Calls into the proxy (e.g. relative API paths resolved against it): add the session.
      return origFetch(withSession(new Request(input, init)));
    }
    if (!fullOrigins.includes(url.origin)) {
      // Warn only for fetches made while serving a page request (app data), not tooling (npm, telemetry).
      if (als.getStore() && url.protocol.startsWith('http') && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) && !warned.has(url.origin)) {
        warned.add(url.origin);
        console.warn(`[stagecraft] Server-side fetch to ${url.origin} is not a declared API origin. It is NOT mocked. Add it to apiOrigins if it is your API.`);
      }
      return origFetch(input, init);
    }
    const target = `${proxyOrigin}/__stagecraft/mock/${encodeURIComponent(url.origin)}${url.pathname}${url.search}`;
    const original = new Request(input, init);
    return origFetch(withSession(new Request(target, original)));
  };

  function withSession(req) {
    const sid = als.getStore()?.sid;
    if (sid) req.headers.set(SESSION_HEADER, sid);
    return req;
  }
}
