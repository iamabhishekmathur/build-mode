import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface Finding {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
  selector?: string;
  where?: string;
}

export interface CheckResult {
  check: string;
  pass: boolean;
  findings: Finding[];
  ms: number;
  notes?: string[];
  artifacts?: string[];
}

export const CODE = /\.(m?[jt]sx?|vue|svelte|css|scss)$/;

/** Changed files in the repo: uncommitted + committed since the merge base with main/master (if any). */
export function changedFiles(root: string): string[] {
  const out = new Set<string>();
  const run = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  for (const l of run(['status', '--porcelain', '--untracked-files=all']).split('\n')) if (l.trim()) out.add(l.slice(3));
  for (const base of ['main', 'master']) {
    const mb = run(['merge-base', 'HEAD', base]).trim();
    if (mb) {
      for (const f of run(['diff', '--name-only', mb, 'HEAD']).split('\n')) if (f) out.add(f);
      break;
    }
  }
  return [...out].filter((f) => !f.startsWith('node_modules/') && existsSync(join(root, f)));
}

/** Lines added in the working tree vs HEAD (and vs the merge base), per file. null = whole file is new. */
export function addedLines(root: string, file: string): Set<number> | null {
  const run = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const tracked = run(['ls-files', '--error-unmatch', file]).status === 0;
  if (!tracked) return null;
  let base = 'HEAD';
  for (const b of ['main', 'master']) {
    const mb = run(['merge-base', 'HEAD', b]);
    if (mb.status === 0 && mb.stdout.trim()) {
      base = mb.stdout.trim();
      break;
    }
  }
  const diff = run(['diff', '-U0', base, '--', file]).stdout;
  const lines = new Set<number>();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < n; i++) lines.add(start + i);
  }
  return lines;
}

export function read(f: string) {
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

export function pkgJson(root: string): any {
  try {
    return JSON.parse(read(join(root, 'package.json')));
  } catch {
    return {};
  }
}

export function result(check: string, t0: number, findings: Finding[], extra: Partial<CheckResult> = {}): CheckResult {
  return { check, pass: !findings.some((f) => f.severity === 'error'), findings, ms: Date.now() - t0, ...extra };
}

/**
 * Path of a CLI from the repo's dependencies: node_modules/.bin up the tree (hoisted installs,
 * monorepos), then the package's bin via require.resolve. `npx --no` only looks in the repo itself.
 */
export function findBin(root: string, bin: string, pkgBin?: string): string[] | null {
  for (let d = root; ; d = dirname(d)) {
    const p = join(d, 'node_modules', '.bin', bin);
    if (existsSync(p)) return [p];
    if (dirname(d) === d) break;
  }
  if (pkgBin) {
    for (const from of [join(root, 'package.json'), import.meta.url]) {
      try {
        return [process.execPath, createRequire(from).resolve(pkgBin)];
      } catch {
        /* next */
      }
    }
  }
  return null;
}
