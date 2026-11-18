import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findConfig, startServer } from '@stagecraft/server';

/** Names that look like production secrets. Never passed to the dev server. */
const DENY = /^(?:.*_)?(?:PROD|PRODUCTION)_|DATABASE_URL|_SECRET$|_SECRET_KEY$|PRIVATE_KEY|AWS_SECRET|STRIPE_SECRET/i;

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

export async function dev(cwd: string, opts: { port?: number; noDevServer?: boolean; host?: string }) {
  const file = findConfig(cwd);
  if (!file) throw new Error('No stagecraft.config.ts. Run "npx stagecraft init".');
  const root = join(file, '..');
  const { engine, server, url } = await startServer(file, { port: opts.port, host: opts.host });
  let child: ChildProcess | null = null;
  const cfg = engine.config;
  if (!opts.noDevServer && cfg.devCommand) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DENY.test(k)) env[k] = v;
    Object.assign(env, envFile(root), { STAGECRAFT: '1', VITE_STAGECRAFT: '1' });
    engine.log(`Starting dev server: ${cfg.devCommand}`);
    child = spawn(cfg.devCommand, { cwd: root, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (d) => process.stdout.write(`[dev] ${d}`));
    child.stderr!.on('data', (d) => process.stderr.write(`[dev] ${d}`));
    child.on('exit', (code) => engine.log(`Dev server exited (${code})`));
    const up = await waitFor(cfg.devUrl, 60_000);
    if (!up) engine.log(`Dev server did not answer at ${cfg.devUrl} within 60 s. The proxy keeps retrying.`);
  }
  engine.log(`Ready: ${url}  (dev server ${cfg.devUrl})`);
  engine.log('Open the URL above. The Stagecraft panel is at the bottom right (Alt+Shift+S hides it).');
  const stop = async () => {
    child?.kill('SIGTERM');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { url, server, engine, child };
}
