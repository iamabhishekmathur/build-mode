import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '..');
export const EXAMPLE = join(REPO, 'examples/ref-react-vite');

/** Copy the example's Stagecraft files to a temp folder inside the repo (so node_modules resolve). */
export function fixture(name = 'fx'): { root: string; config: string } {
  const root = join(REPO, 'tests/.tmp', `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(root, { recursive: true });
  cpSync(join(EXAMPLE, 'stagecraft'), join(root, 'stagecraft'), { recursive: true });
  cpSync(join(EXAMPLE, 'stagecraft.config.ts'), join(root, 'stagecraft.config.ts'));
  return { root, config: join(root, 'stagecraft.config.ts') };
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | Promise<T>, ms = 5000, step = 25): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(step);
  }
  throw new Error(`Timed out waiting${last ? `: ${(last as Error).message}` : ''}`);
}

/**
 * Copy examples/multi-repo into a temp folder and make each folder its own git repo,
 * like four separate repos on a developer's machine.
 */
export function multiRepoFixture(ports: { web: number; admin: number }) {
  const root = join(REPO, 'tests/.tmp', `mr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const names = ['acme-web', 'acme-ui', 'acme-admin', 'acme-api'];
  for (const n of names) {
    cpSync(join(REPO, 'examples/multi-repo', n), join(root, n), { recursive: true, filter: (src) => !src.includes('node_modules') });
  }
  const sub = (file: string, pairs: [string, string][]) => {
    let t = readFileSync(file, 'utf8');
    for (const [a, b] of pairs) t = t.split(a).join(b);
    writeFileSync(file, t);
  };
  sub(join(root, 'acme-web/stagecraft.config.ts'), [['5191', String(ports.web)], ['5192', String(ports.admin)]]);
  sub(join(root, 'acme-web/vite.config.ts'), [['5191', String(ports.web)]]);
  sub(join(root, 'acme-admin/vite.config.ts'), [['5192', String(ports.admin)]]);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  for (const n of names) {
    const d = join(root, n);
    git(d, 'init', '-q', '-b', 'main');
    git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  }
  return { root, web: join(root, 'acme-web'), ui: join(root, 'acme-ui'), admin: join(root, 'acme-admin'), api: join(root, 'acme-api') };
}
