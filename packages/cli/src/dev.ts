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
  if (!file) throw new Error('No stagecraft.config.ts. Run "npx stagecraft init".');
  const root = join(file, '..');
  const { engine, server, url, apps } = await startServer(file, { port: opts.port, host: opts.host });
  const children: ChildProcess[] = [];
  const cfg = engine.config;
  const repos = resolveWorkspace(root, cfg);
  if (!opts.noLink) linkLibraries(repos, (m) => engine.log(m));
  const start = (name: string, command: string, cwd: string, devUrl: string, proxyUrl: string) => {
    const env = devServerEnv({ proxyUrl, apiOrigins: cfg.apiOrigins, extra: envFile(root) });
    engine.log(`Starting ${name}: ${command}`);
    // Own process group, so stopping kills the whole tree (npm → next → workers), not just the shell.
    const c = spawn(command, { cwd, env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout!.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
    c.stderr!.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
    c.on('exit', (code) => engine.log(`${name} exited (${code})`));
    children.push(c);
    return waitFor(devUrl, 60_000).then((ok) => ok || engine.log(`${name} did not answer at ${devUrl} within 60 s. The proxy keeps retrying.`));
  };
  if (!opts.noDevServer) {
    const waits: Promise<unknown>[] = [];
    if (cfg.devCommand) waits.push(start('dev', cfg.devCommand, root, cfg.devUrl, url));
    for (const r of repos) {
      if (r.host || r.role !== 'app' || !r.devCommand || !r.devUrl) continue;
      const proxyUrl = apps.find((a) => a.name === r.name)?.url ?? url;
      waits.push(start(r.name, r.devCommand, r.abs, r.devUrl, proxyUrl));
    }
    await Promise.all(waits);
  }
  engine.log(`Ready: ${url}  (dev server ${cfg.devUrl})`);
  for (const r of repos) if (r.role === 'app' && r.mount) engine.log(`  ${r.name}: ${url}${r.mount}`);
  for (const a of apps) engine.log(`  ${a.name}: ${a.url}`);
  engine.log('Open the URL above. The Stagecraft panel is at the bottom right (Alt+Shift+S hides it).');
  const stop = async () => {
    for (const child of children) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { url, server, engine, children };
}
