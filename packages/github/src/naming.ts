import type { RepoRef } from './client.ts';

/** Lowercase, ASCII, `a-z0-9-` only, no leading/trailing/double dashes, at most `max` chars. */
export function sanitizeSlug(input: string, max = 60): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s;
}

/** FR-1102: every prototype is a branch `proto/<user>/<slug>`. */
export function protoBranch(user: string, slug: string): string {
  const u = sanitizeSlug(user, 39); // GitHub logins are at most 39 chars
  const s = sanitizeSlug(slug);
  if (!u) throw new Error(`Cannot make a branch name: user "${user}" has no usable characters`);
  if (!s) throw new Error(`Cannot make a branch name: slug "${slug}" has no usable characters`);
  return `proto/${u}/${s}`;
}

/** `proto/<user>/<slug>` → { user, slug }, or null for any other branch. */
export function parseProtoBranch(branch: string): { user: string; slug: string } | null {
  const m = /^proto\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(branch);
  return m ? { user: m[1]!, slug: m[2]! } : null;
}

export const isProtoBranch = (branch: string) => branch.startsWith('proto/');

/** "new-agent-controls" → "New agent controls" (default PR title). */
export function humanize(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Owner and repo from a git remote URL:
 *   https://github.com/acme/ui(.git)   git@github.com:acme/ui.git   ssh://git@github.com/acme/ui.git
 *   git://…, https://user:token@github.com/…  (any host: owner/name is all we need)
 */
export function parseRemoteUrl(url: string): (RepoRef & { host: string }) | null {
  const u = url.trim();
  let m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (!m) m = /^(?:[^@/]+@)?([^/:]+):\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  return m ? { host: m[1]!, owner: m[2]!, repo: m[3]! } : null;
}
