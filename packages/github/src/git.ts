import { execFileSync, spawnSync } from 'node:child_process';
import { parseRemoteUrl } from './naming.ts';
import type { RepoRef } from './client.ts';

/** Local git through child_process. Pushes go to `origin` only, never with --force. */

export const DEFAULT_CO_AUTHOR = 'Claude <noreply@anthropic.com>';

export function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export const repoRoot = (cwd: string) => git(cwd, ['rev-parse', '--show-toplevel']);
export const currentBranch = (cwd: string) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
export const headSha = (cwd: string) => git(cwd, ['rev-parse', 'HEAD']);

export function isDirty(cwd: string): boolean {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' }).trim().length > 0;
}

export function branchExists(cwd: string, branch: string): boolean {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null;
}

/**
 * `origin` as configured (not `git remote get-url`, which applies `insteadOf` rewrites), parsed
 * to owner/repo.
 */
export function originRepo(cwd: string): RepoRef & { host: string; url: string } {
  const url = tryGit(cwd, ['config', '--get', 'remote.origin.url']);
  if (!url) throw new Error(`${cwd}: no "origin" remote. Add the GitHub repo as origin first.`);
  const p = parseRemoteUrl(url);
  if (!p) throw new Error(`${cwd}: cannot read owner/repo from origin URL "${url}"`);
  return { ...p, url };
}

/** The human who saves the prototype: git config user.name / user.email (FR-1109). */
export function humanIdentity(cwd: string): { name: string; email: string } {
  const name = tryGit(cwd, ['config', 'user.name']);
  const email = tryGit(cwd, ['config', 'user.email']);
  if (!name || !email) throw new Error('Set your git identity first: git config --global user.name "…" && git config --global user.email "…"');
  return { name, email };
}

/** Message with a `Co-authored-by:` trailer for the agent, unless it already has that trailer. */
export function withCoAuthor(message: string, coAuthor = DEFAULT_CO_AUTHOR): string {
  const trailer = `Co-authored-by: ${coAuthor}`;
  if (message.split('\n').some((l) => l.trim().toLowerCase() === trailer.toLowerCase())) return message;
  return `${message.trimEnd()}\n\n${trailer}\n`;
}

/**
 * Stage everything and commit. Author and committer are the human from git config; the agent is
 * a co-author (FR-1109). Returns the new SHA, or null if there was nothing to commit.
 */
export function commitAll(cwd: string, message: string, opts: { coAuthor?: string } = {}): string | null {
  if (!isDirty(cwd)) return null;
  const who = humanIdentity(cwd);
  git(cwd, ['add', '-A']);
  const env = { ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
  const r = spawnSync('git', ['commit', '-q', '-F', '-'], { cwd, input: withCoAuthor(message, opts.coAuthor), encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git commit failed: ${(r.stderr || r.stdout).trim()}`);
  return headSha(cwd);
}

/**
 * `git push -u origin <branch>`. Refuses the repo's base branch: prototypes only ever push their own
 * branch, so branch protection on main/release branches is never in the way (FR-1108).
 */
export function pushBranch(cwd: string, branch: string, opts: { protectedBranches?: string[] } = {}) {
  if (opts.protectedBranches?.includes(branch)) throw new Error(`Refusing to push "${branch}": Stagecraft pushes only prototype branches, never a base branch.`);
  git(cwd, ['push', '-q', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
}

/** Commits on HEAD that `origin/<base>` does not have. Fetches the base first. */
export function commitsAhead(cwd: string, base: string): number {
  tryGit(cwd, ['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  const n = tryGit(cwd, ['rev-list', '--count', `refs/remotes/origin/${base}..HEAD`]);
  return n === null ? 0 : Number(n);
}

/** Per-branch base recorded by `branch-from` (git config branch.<name>.stagecraftBase). */
export function recordedBase(cwd: string, branch: string): string | null {
  return tryGit(cwd, ['config', '--get', `branch.${branch}.stagecraftBase`]);
}

export function recordBase(cwd: string, branch: string, base: string) {
  git(cwd, ['config', `branch.${branch}.stagecraftBase`, base]);
}
