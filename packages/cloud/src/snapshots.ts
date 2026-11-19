import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/**
 * Git on the host never runs repository hooks or fsmonitor: the workspace was written to by
 * untrusted install scripts inside the sandbox.
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Cache key part: lockfile(s) + package.json + Node major (FR-107). */
export function lockHash(dir: string): string {
  const h = createHash('sha256');
  for (const f of ['package.json', ...LOCKFILES]) {
    const p = join(dir, f);
    if (existsSync(p)) h.update(f).update(readFileSync(p));
  }
  h.update(process.versions.node.split('.')[0]!);
  return h.digest('hex').slice(0, 24);
}

export function installCommand(dir: string): string[] | null {
  if (!existsSync(join(dir, 'package.json'))) return null;
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return ['npx', '--yes', 'pnpm@9', 'install', '--frozen-lockfile'];
  if (existsSync(join(dir, 'yarn.lock'))) return ['npx', '--yes', 'yarn@1', 'install', '--frozen-lockfile', '--non-interactive'];
  if (existsSync(join(dir, 'package-lock.json'))) return ['npm', 'ci', '--no-audit', '--no-fund'];
  return ['npm', 'install', '--no-audit', '--no-fund'];
}

/**
 * Workspace snapshots: repo checkout (with .git) + installed dependencies, as a tarball keyed by
 * tenant + repo + lockfile hash. A second user with the same lockfile skips the install.
 */
export class SnapshotStore {
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  key(tenant: string, repoUrl: string, hash: string): string {
    const repo = createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
    return `${tenant}/${repo}/${hash}`;
  }

  path(key: string) {
    return join(this.dir, `${key}.tar.gz`);
  }

  has(key: string) {
    return existsSync(this.path(key));
  }

  size(key: string) {
    return this.has(key) ? statSync(this.path(key)).size : 0;
  }

  create(fromDir: string, key: string) {
    const out = this.path(key);
    mkdirSync(join(out, '..'), { recursive: true });
    const tmp = `${out}.tmp`;
    execFileSync('/usr/bin/tar', ['-czf', tmp, '-C', fromDir, '.'], { stdio: 'pipe' });
    renameSync(tmp, out);
  }

  restore(key: string, toDir: string) {
    rmSync(toDir, { recursive: true, force: true });
    mkdirSync(toDir, { recursive: true });
    // --no-same-owner / no absolute paths: tar refuses ../ and / entries by default.
    execFileSync('/usr/bin/tar', ['-xzf', this.path(key), '-C', toDir, '--no-same-owner'], { stdio: 'pipe' });
  }
}
