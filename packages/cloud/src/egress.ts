import http from 'node:http';
import net from 'node:net';

/** Hosts every sandbox may reach: package registries, GitHub, agent vendors, Figma. */
export const BASE_ALLOW = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  '.npmjs.org',
  'github.com',
  '.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'api.anthropic.com',
  'api.openai.com',
  '.cursor.sh',
  'mcp.figma.com',
  'api.figma.com',
];

export interface EgressDecision {
  at: string;
  sandboxIp: string;
  tenant?: string;
  host: string;
  port: number;
  allowed: boolean;
}

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return false; // raw IPs never
  return allow.some((a) => (a.startsWith('.') ? h.endsWith(a) || h === a.slice(1) : h === a.toLowerCase()));
}

/**
 * The only way out of a sandbox. HTTP CONNECT (TLS is not intercepted) and plain-HTTP proxying,
 * with a per-tenant allowlist keyed by the sandbox's source IP. Every decision is logged
 * (PRD 6.7: "any other egress is blocked and logged"). Optionally chains to an upstream proxy.
 */
export class EgressProxy {
  server: http.Server;
  decisions: EgressDecision[] = [];
  private bySandbox = new Map<string, { tenant: string; allow: string[] }>();
  private upstream?: URL;

  constructor(opts: { upstreamProxy?: string } = {}) {
    this.upstream = opts.upstreamProxy ? new URL(opts.upstreamProxy) : undefined;
    this.server = http.createServer((req, res) => this.plain(req, res));
    this.server.on('connect', (req, socket, head) => this.connect(req, socket as net.Socket, head));
  }

  register(sandboxIp: string, tenant: string, allow: string[]) {
    this.bySandbox.set(sandboxIp, { tenant, allow: [...BASE_ALLOW, ...allow] });
  }
  unregister(sandboxIp: string) {
    this.bySandbox.delete(sandboxIp);
  }

  listen(port: number, host = '0.0.0.0') {
    return new Promise<void>((r) => this.server.listen(port, host, () => r()));
  }
  close() {
    this.server.closeAllConnections?.();
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private decide(ip: string, host: string, port: number): boolean {
    const src = ip.replace(/^::ffff:/, '');
    const entry = this.bySandbox.get(src);
    const allowed = !!entry && (port === 443 || port === 80) && hostAllowed(host, entry.allow);
    this.decisions.push({ at: new Date().toISOString(), sandboxIp: src, tenant: entry?.tenant, host, port, allowed });
    if (this.decisions.length > 5000) this.decisions.splice(0, 1000);
    return allowed;
  }

  private connect(req: http.IncomingMessage, client: net.Socket, head: Buffer) {
    const [host, portS] = (req.url ?? '').split(':');
    const port = Number(portS || 443);
    if (!host || !this.decide(req.socket.remoteAddress ?? '', host, port)) {
      client.end('HTTP/1.1 403 Forbidden\r\nX-Stagecraft-Egress: denied\r\n\r\n');
      return;
    }
    const fail = () => client.destroy();
    if (this.upstream) {
      const up = net.connect(Number(this.upstream.port || 80), this.upstream.hostname, () => {
        up.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      });
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        up.off('data', onData);
        if (!/^HTTP\/1\.[01] 200/.test(buf.subarray(0, i).toString())) {
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          return up.destroy();
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = buf.subarray(i + 4);
        if (rest.length) client.write(rest);
        if (head.length) up.write(head);
        client.pipe(up).pipe(client);
      };
      up.on('data', onData);
      up.on('error', fail);
      client.on('error', () => up.destroy());
      return;
    }
    const up = net.connect(port, host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      client.pipe(up).pipe(client);
    });
    up.on('error', fail);
    client.on('error', () => up.destroy());
  }

  private plain(req: http.IncomingMessage, res: http.ServerResponse) {
    let u: URL;
    try {
      u = new URL(req.url ?? '');
    } catch {
      res.writeHead(400);
      return res.end('absolute URL required');
    }
    if (u.protocol !== 'http:' || !this.decide(req.socket.remoteAddress ?? '', u.hostname, Number(u.port || 80))) {
      res.writeHead(403, { 'x-stagecraft-egress': 'denied' });
      return res.end(`Stagecraft egress: ${u.hostname} is not allowed from this sandbox`);
    }
    const target = this.upstream ?? u;
    const up = http.request({ hostname: target.hostname, port: target.port || 80, method: req.method, path: this.upstream ? u.href : u.pathname + u.search, headers: { ...req.headers, host: u.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  }
}
