import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { devServerEnv, findConfig, linkLibraries, resolveWorkspace, startServer } from '@stagecraft/server';

function envFile(root: string): Record<string, string> {
  const f = join(root, '.env.stagecraft');
  if (!existsSync(f)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function waitFor(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

export async function dev(cwd: string, opts: { port?: number; noDevServer?: boolean; noLink?: boolean; host?: string }) {
  const file = findConfig(cwd);
  if (!file) throw new Error('No stagecraft.config.ts. Run "npx --no stagecraft init".');
  const root = join(file, '..');
  const { engine, server, url, apps } = await startServer(file, { port: opts.port, host: opts.host });
  const children: ChildProcess[] = [];
  const cfg = engine.config;
  const repos = resolveWorkspace(root, cfg);
  if (!opts.noLink) linkLibraries(repos, (m) => engine.log(m));
  // Recent dev-server output for `dev_logs` (FR-206), with secret-looking values masked.
  const logLines: string[] = [];
  const keep = (name: string, d: Buffer) => {
    for (const line of String(d).split('\n')) if (line.trim()) logLines.push(`[${name}] ${line.replace(/((?:key|token|secret|password)[\w-]*["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1****')}`);
    if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  };
  const start = (name: string, command: string, cwd: string, devUrl: string, proxyUrl: string) => {
    const env = devServerEnv({ proxyUrl, apiOrigins: engine.config.apiOrigins, extra: envFile(root) });
    engine.log(`Starting ${name}: ${command}`);
    // Own process group, so stopping kills the whole tree (npm → next → workers), not just the shell.
    const c = spawn(command, { cwd, env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout!.on('data', (d) => (keep(name, d), process.stdout.write(`[${name}] ${d}`)));
    c.stderr!.on('data', (d) => (keep(name, d), process.stderr.write(`[${name}] ${d}`)));
    c.on('exit', (code) => engine.log(`${name} exited (${code})`));
    children.push(c);
    return waitFor(devUrl, 60_000).then((ok) => ok || engine.log(`${name} did not answer at ${devUrl} within 60 s. The proxy keeps retrying.`));
  };
  const startAll = async () => {
    const c = engine.config;
    const waits: Promise<unknown>[] = [];
    if (c.devCommand) waits.push(start('dev', c.devCommand, root, c.devUrl, url));
    for (const r of resolveWorkspace(root, c)) {
      if (r.host || r.role !== 'app' || !r.devCommand || !r.devUrl) continue;
      const proxyUrl = apps.find((a) => a.name === r.name)?.url ?? url;
      waits.push(start(r.name, r.devCommand, r.abs, r.devUrl, proxyUrl));
    }
    await Promise.all(waits);
  };
  const killAll = async () => {
    for (const child of children.splice(0)) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  };
  if (!opts.noDevServer) await startAll();
  // Agents fix env vars or config, then restart without owning the process (dev_restart).
  server.devControl = {
    async restart() {
      await killAll();
      await engine.reload();
      logLines.push('[stagecraft] restarting dev servers');
      if (!opts.noDevServer) await startAll();
      return 'restarted';
    },
    logs: (tail = 120) => logLines.slice(-tail),
  };
  engine.log(`Ready: ${url}  (dev server ${cfg.devUrl})`);
  for (const r of repos) if (r.role === 'app' && r.mount) engine.log(`  ${r.name}: ${url}${r.mount}`);
  for (const a of apps) engine.log(`  ${a.name}: ${a.url}`);
  engine.log('Open the URL above. The Stagecraft panel is at the bottom right (Alt+Shift+S hides it).');
  const stop = async () => {
    await killAll();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { url, server, engine, children };
}
