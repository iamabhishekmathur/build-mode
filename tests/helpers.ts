import { cpSync, mkdirSync } from 'node:fs';
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
