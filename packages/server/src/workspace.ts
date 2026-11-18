import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { StagecraftConfig, WorkspaceRepo } from '@stagecraft/core';
import { compile, type Route } from './routes.ts';

export interface ResolvedRepo extends WorkspaceRepo {
  name: string;
  abs: string;
  host: boolean;
}

/** Host repo + every workspace repo, with absolute paths. */
export function resolveWorkspace(root: string, config: Pick<StagecraftConfig, 'workspace'>): ResolvedRepo[] {
  const out: ResolvedRepo[] = [{ name: '(host)', path: '.', role: 'app', abs: resolve(root), host: true }];
  for (const [name, r] of Object.entries(config.workspace?.repos ?? {})) {
    out.push({ ...r, name, abs: resolve(root, r.path), host: false, readOnly: r.readOnly ?? r.role === 'api' });
  }
  return out;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isGit(dir: string) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']) === realpathSync(dir);
  } catch {
    return false;
  }
}

export interface RepoStatus {
  name: string;
  role: string;
  path: string;
  present: boolean;
  git: boolean;
  branch: string | null;
  changedFiles: string[];
  readOnly: boolean;
  links: { consumer: string; package: string; linked: boolean }[];
}

/** Repos that consume libraries: the host and every app repo. */
function consumers(ws: ResolvedRepo[]) {
  return ws.filter((r) => r.role === 'app' && existsSync(r.abs));
}

function linkTarget(lib: ResolvedRepo) {
  return resolve(lib.abs, lib.packagePath ?? '.');
}

function linkPath(consumer: ResolvedRepo, pkg: string) {
  return join(consumer.abs, 'node_modules', ...pkg.split('/'));
}

export function isLinked(consumer: ResolvedRepo, lib: ResolvedRepo): boolean {
  const p = linkPath(consumer, lib.package!);
  try {
    return lstatSync(p).isSymbolicLink() && resolve(dirname(p), readlinkSync(p)) === linkTarget(lib);
  } catch {
    return false;
  }
}

export function workspaceStatus(ws: ResolvedRepo[]): RepoStatus[] {
  const libs = ws.filter((r) => r.role === 'library' && r.package);
  return ws.map((r) => {
    const present = existsSync(r.abs);
    const g = present && isGit(r.abs);
    let branch: string | null = null;
    let changedFiles: string[] = [];
    if (g) {
      try {
        branch = git(r.abs, ['rev-parse', '--abbrev-ref', 'HEAD']);
      } catch {
        branch = null; // no commits yet
      }
      // Not git(): its trim() would eat the leading space of " M file" and shift the slice.
      changedFiles = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: r.abs, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3))
        .filter((f) => !f.startsWith('node_modules/'));
    }
    const links = r.role === 'app' && present ? libs.map((l) => ({ consumer: r.name, package: l.package!, linked: isLinked(r, l) })) : [];
    return { name: r.name, role: r.role, path: r.path, present, git: g, branch, changedFiles, readOnly: !!r.readOnly, links };
  });
}

/** Clone missing repos that have a `git` URL. */
export function cloneMissing(ws: ResolvedRepo[], log: (m: string) => void) {
  for (const r of ws) {
    if (r.host || existsSync(r.abs)) continue;
    if (!r.git) {
      log(`! ${r.name}: missing at ${r.path} and has no git URL`);
      continue;
    }
    log(`cloning ${r.name} → ${r.path}`);
    mkdirSync(dirname(r.abs), { recursive: true });
    execFileSync('git', ['clone', r.git, r.abs], { stdio: 'inherit' });
  }
}

/**
 * Dev-only link of library packages into each app's node_modules (a symlink, like `npm link`),
 * so edits in the library repo show up live. The original folder is kept in a backup and
 * restored by `unlink`. No package.json or lockfile changes.
 */
export function linkLibraries(ws: ResolvedRepo[], log: (m: string) => void) {
  for (const lib of ws.filter((r) => r.role === 'library' && r.package)) {
    if (!existsSync(linkTarget(lib))) {
      log(`! ${lib.name}: ${relative(process.cwd(), linkTarget(lib))} not found (run "stagecraft workspace clone")`);
      continue;
    }
    for (const c of consumers(ws)) {
      if (isLinked(c, lib)) continue;
      const p = linkPath(c, lib.package!);
      mkdirSync(dirname(p), { recursive: true });
      if (existsSync(p) || isDanglingLink(p)) {
        const backup = join(c.abs, 'node_modules', '.stagecraft-backup', lib.package!.replace('/', '__'));
        rmSync(backup, { recursive: true, force: true });
        mkdirSync(dirname(backup), { recursive: true });
        renameSync(p, backup);
      }
      symlinkSync(relative(dirname(p), linkTarget(lib)), p, 'dir');
      log(`linked ${lib.package} in ${c.name} → ${lib.path}${lib.packagePath ? '/' + lib.packagePath : ''}`);
    }
  }
}

function isDanglingLink(p: string) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function unlinkLibraries(ws: ResolvedRepo[], log: (m: string) => void) {
  for (const lib of ws.filter((r) => r.role === 'library' && r.package)) {
    for (const c of consumers(ws)) {
      if (!isLinked(c, lib)) continue;
      const p = linkPath(c, lib.package!);
      rmSync(p);
      const backup = join(c.abs, 'node_modules', '.stagecraft-backup', lib.package!.replace('/', '__'));
      if (existsSync(backup)) renameSync(backup, p);
      log(`unlinked ${lib.package} in ${c.name}${existsSync(p) ? ' (restored installed version)' : ''}`);
    }
  }
}

/** Same prototype branch in every writable repo. Creates it from the current HEAD if needed. */
export function switchBranch(ws: ResolvedRepo[], branch: string, log: (m: string) => void) {
  for (const r of ws) {
    if (r.readOnly || !existsSync(r.abs) || !isGit(r.abs)) continue;
    const exists = (() => {
      try {
        git(r.abs, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
        return true;
      } catch {
        return false;
      }
    })();
    git(r.abs, exists ? ['checkout', branch] : ['checkout', '-b', branch]);
    log(`${r.name}: on ${branch}${exists ? '' : ' (new)'}`);
  }
}

// ---------- OpenAPI spec coverage (mock drift, PRD R-5) ----------

export interface SpecOperation {
  method: string;
  path: string;
  operationId?: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function readOpenApi(file: string): SpecOperation[] {
  const raw = readFileSync(file, 'utf8');
  const doc = file.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  const prefix = (() => {
    const url = doc?.servers?.[0]?.url;
    if (typeof url !== 'string') return '';
    try {
      return new URL(url, 'http://x').pathname.replace(/\/$/, '');
    } catch {
      return '';
    }
  })();
  const ops: SpecOperation[] = [];
  for (const [p, item] of Object.entries<any>(doc?.paths ?? {})) {
    for (const m of METHODS) {
      if (item?.[m]) ops.push({ method: m.toUpperCase(), path: prefix + p.replace(/\{([^}]+)\}/g, ':$1'), operationId: item[m].operationId });
    }
  }
  return ops;
}

const sample = (path: string) => path.replace(/:[^/]+/g, 'x');

/** Spec operations with no mock, and mocks for endpoints the spec does not have. */
export function specCoverage(ops: SpecOperation[], routes: Route<unknown>[]) {
  const mocked = (op: SpecOperation) => routes.some((r) => (r.method === '*' || r.method === op.method) && r.re.test(sample(op.path)));
  const opRoutes = ops.map((o) => compile(`${o.method} ${o.path}`, o));
  const inSpec = (r: Route<unknown>) => opRoutes.some((o) => (r.method === '*' || o.method === r.method) && o.re.test(sample(r.key.replace(/^\S+\s+/, ''))));
  return {
    unmocked: ops.filter((o) => !mocked(o)).map((o) => `${o.method} ${o.path}`),
    notInSpec: routes.filter((r) => !inSpec(r)).map((r) => r.key),
  };
}
