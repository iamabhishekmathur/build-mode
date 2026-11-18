import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { findConfig, loadConfig, resolveWorkspace, workspaceStatus } from '@stagecraft/server';
import { defaultBody, getSection, replaceUserPart, setSection } from './body.ts';
import { GitHubError, PREVIEW_MARKER, PROTOTYPE_LABEL, type CheckConclusion, type GhCheckRun, type GhComment, type GhPull, type GitHubClient, type RepoRef } from './client.ts';
import { branchExists, commitAll, commitsAhead, currentBranch, git, headSha, humanIdentity, isDirty, originRepo, pushBranch, recordBase, recordedBase, repoRoot } from './git.ts';
import { humanize, isProtoBranch, parseProtoBranch, protoBranch, sanitizeSlug } from './naming.ts';

/**
 * Prototype workflows on top of the client and local git (FR-1102..FR-1109).
 * Nothing here merges: an engineer merges under the repo's branch protection.
 */

export interface GithubContext {
  client: GitHubClient;
  log?: (m: string) => void;
  /** Agent co-author trailer value. Default "Claude <noreply@anthropic.com>". */
  coAuthor?: string;
  /** GitHub login for proto/<user>/<slug>. Default: STAGECRAFT_USER, then GET /user, then git user.name. */
  user?: string;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_GATE = 'npx --no stagecraft check handoff';

const say = (ctx: GithubContext, m: string) => ctx.log?.(m);
const short = (r: RepoRef) => `${r.owner}/${r.repo}`;

export async function resolveUser(ctx: GithubContext, cwd: string): Promise<string> {
  if (ctx.user) return ctx.user;
  const env = ctx.env ?? process.env;
  if (env.STAGECRAFT_USER) return env.STAGECRAFT_USER;
  try {
    return (await ctx.client.getViewer()).login;
  } catch {
    return humanIdentity(cwd).name;
  }
}

function checkout(dir: string, branch: string) {
  if (currentBranch(dir) === branch) return;
  git(dir, branchExists(dir, branch) ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch]);
}

// ---------- open / update the draft PR ----------

export interface OpenOptions {
  title?: string;
  /** User-written body. Replaces the user part on update; managed sections are kept. */
  body?: string;
  /** For a new proto/<user>/<slug> branch when the repo is on its base branch. Default: from the title. */
  slug?: string;
  /** Use exactly this branch (multi-repo: one name across repos). */
  branch?: string;
  base?: string;
  /** Commit message for uncommitted changes. Default: the title. */
  message?: string;
  /** Content of the managed "Related PRs" section (multi-repo). */
  related?: string;
}

export interface OpenResult {
  dir: string;
  repo: RepoRef;
  branch: string;
  base: string;
  pr: GhPull;
  created: boolean;
  committed: string | null;
}

/** Pick the branch to use: the given one, the current one, or a new proto/<user>/<slug>. */
async function targetBranch(ctx: GithubContext, dir: string, defaultBranch: string, o: OpenOptions): Promise<string> {
  if (o.branch) return o.branch;
  const cur = currentBranch(dir);
  if (cur === 'HEAD') throw new Error('Detached HEAD: check out a branch first.');
  if (isProtoBranch(cur) || (cur !== defaultBranch && cur !== o.base)) return cur;
  const slug = o.slug ?? (o.title ? sanitizeSlug(o.title) : '');
  if (!slug) throw new Error(`You are on "${cur}". Give the prototype a name: --slug <name> or --title "<title>".`);
  return protoBranch(await resolveUser(ctx, dir), slug);
}

/**
 * FR-1102: commit (human author, agent co-author), push the prototype branch, then create the draft
 * PR with the `stagecraft-prototype` label, or update the existing one. Idempotent.
 */
export async function openPr(ctx: GithubContext, cwd: string, o: OpenOptions = {}): Promise<OpenResult> {
  const dir = repoRoot(cwd);
  const r = originRepo(dir);
  const info = await ctx.client.getRepo(r);
  const branch = await targetBranch(ctx, dir, info.default_branch, o);
  checkout(dir, branch);
  const base = o.base ?? recordedBase(dir, branch) ?? info.default_branch;
  if (branch === base || branch === info.default_branch) throw new Error(`"${branch}" is a base branch. Prototypes live on their own branch (proto/<user>/<slug>).`);

  const title = o.title ?? (parseProtoBranch(branch) ? humanize(parseProtoBranch(branch)!.slug) : humanize(branch.split('/').pop()!));
  const committed = commitAll(dir, o.message ?? title, { coAuthor: ctx.coAuthor });
  if (committed) say(ctx, `${short(r)}: committed ${committed.slice(0, 7)} on ${branch}`);
  if (commitsAhead(dir, base) === 0) throw new Error(`${short(r)}: no commits on ${branch} beyond ${base}. Save a change first.`);
  pushBranch(dir, branch, { protectedBranches: [info.default_branch, base] });
  say(ctx, `${short(r)}: pushed ${branch}`);

  let pr = await ctx.client.findPullByHead(r, branch);
  let created = false;
  if (!pr) {
    let body = o.body ?? defaultBody({ branch, base });
    if (o.related) body = setSection(body, 'related', o.related);
    pr = await ctx.client.createDraftPull(r, { title, head: branch, base, body });
    created = true;
    say(ctx, `${short(r)}: opened draft PR #${pr.number} ${pr.html_url}`);
  } else {
    const old = pr.body ?? '';
    let body = o.body !== undefined ? replaceUserPart(old, o.body) : old;
    if (o.related !== undefined) body = setSection(body, 'related', o.related);
    const patch: { title?: string; body?: string } = {};
    if (o.title && o.title !== pr.title) patch.title = o.title;
    if (body !== old) patch.body = body;
    if (Object.keys(patch).length) pr = await ctx.client.updatePull(r, pr.number, patch);
    say(ctx, `${short(r)}: updated PR #${pr.number} ${pr.html_url}`);
  }
  if (!pr.labels?.some((l) => l.name === PROTOTYPE_LABEL.name)) {
    const labels = await ctx.client.addLabel(r, pr.number);
    pr = { ...pr, labels };
  }
  return { dir, repo: r, branch, base, pr, created, committed };
}

// ---------- status ----------

export interface StatusResult {
  repo: RepoRef;
  branch: string;
  pr: GhPull | null;
  previewComment: GhComment | null;
  check: GhCheckRun | null;
  localAhead: boolean;
  dirty: boolean;
}

export async function prStatus(ctx: GithubContext, cwd: string): Promise<StatusResult> {
  const dir = repoRoot(cwd);
  const r = originRepo(dir);
  const branch = currentBranch(dir);
  const pr = await ctx.client.findPullByHead(r, branch);
  let previewComment: GhComment | null = null;
  let check: GhCheckRun | null = null;
  if (pr) {
    previewComment = (await ctx.client.listComments(r, pr.number)).find((c) => c.body?.includes(PREVIEW_MARKER)) ?? null;
    try {
      check = await ctx.client.findCheckRun(r, pr.head.sha);
    } catch {
      check = null;
    }
  }
  return { repo: r, branch, pr, previewComment, check, localAhead: pr ? headSha(dir) !== pr.head.sha : false, dirty: isDirty(dir) };
}

async function requirePr(ctx: GithubContext, cwd: string) {
  const dir = repoRoot(cwd);
  const r = originRepo(dir);
  const branch = currentBranch(dir);
  const pr = await ctx.client.findPullByHead(r, branch);
  if (!pr) throw new Error(`${short(r)}: no open PR for ${branch}. Run "npx --no stagecraft pr open" first.`);
  return { dir, r, branch, pr };
}

// ---------- preview comment + check (FR-1104) ----------

export interface CommentOptions {
  body?: string;
  previewUrl?: string;
  /** State-matrix screenshot: an https URL, or a file committed in the repo. */
  screenshot?: string;
  conclusion?: CheckConclusion;
}

function screenshotUrl(dir: string, r: RepoRef & { host: string }, sha: string, s: string): string {
  if (/^https?:\/\//.test(s)) return s;
  const rel = relative(dir, resolve(s)).split('\\').join('/');
  try {
    git(dir, ['cat-file', '-e', `${sha}:${rel}`]);
  } catch {
    throw new Error(`Screenshot "${s}" is not in the pushed commit ${sha.slice(0, 7)}. Commit and push it (pr open), or pass an https URL.`);
  }
  // Blob URL with ?raw=true: renders for anyone who can read the repo (private repos included).
  return `https://${r.host === 'github.com' ? 'github.com' : r.host}/${r.owner}/${r.repo}/blob/${sha}/${rel}?raw=true`;
}

/**
 * Upsert the one preview comment (hidden marker, updated in place on every push) and the
 * "Stagecraft" check run on the PR head commit.
 */
export async function commentPreview(ctx: GithubContext, cwd: string, o: CommentOptions) {
  const { dir, pr } = await requirePr(ctx, cwd);
  const r = originRepo(dir);
  const sha = pr.head.sha;
  const img = o.screenshot ? screenshotUrl(dir, r, sha, o.screenshot) : undefined;
  const lines = [PREVIEW_MARKER, '### Stagecraft preview', ''];
  if (o.previewUrl) lines.push(`**Preview:** ${o.previewUrl}`, '');
  if (img) lines.push(`![State matrix](${img})`, '');
  if (o.body?.trim()) lines.push(o.body.trim(), '');
  lines.push(`<sub>Updated for ${sha.slice(0, 7)}. Stagecraft edits this comment on every push.</sub>`);
  const { comment, created } = await ctx.client.upsertComment(r, pr.number, lines.join('\n'));
  say(ctx, `${short(r)}#${pr.number}: ${created ? 'posted' : 'updated'} preview comment ${comment.html_url}`);

  let check: GhCheckRun | null = null;
  let checkWarning: string | undefined;
  try {
    const res = await ctx.client.upsertCheckRun(r, {
      headSha: sha,
      title: 'Prototype preview',
      summary: [o.previewUrl ? `Preview: ${o.previewUrl}` : 'No preview URL given.', img ? `![State matrix](${img})` : ''].filter(Boolean).join('\n\n'),
      text: o.body,
      detailsUrl: o.previewUrl,
      conclusion: o.conclusion,
      images: img ? [{ alt: 'State matrix', image_url: img }] : undefined,
    });
    check = res.check;
    say(ctx, `${short(r)}#${pr.number}: ${res.created ? 'created' : 'updated'} check "${check.name}" on ${sha.slice(0, 7)}`);
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 403) throw e;
    checkWarning = 'Check run skipped: GitHub allows check runs only with a GitHub App token (a personal token gets 403). The PR comment was still updated.';
    say(ctx, `! ${checkWarning}`);
  }
  return { pr, comment, created, check, checkWarning };
}

// ---------- ready for engineering (FR-1105) ----------

export interface ReadyOptions {
  gate?: string;
  /** Reason to mark ready although the gate fails. Recorded in the PR body. */
  override?: string;
  reviewers?: string[];
}

export interface ReadyResult {
  status: 'ready' | 'already-ready' | 'refused';
  pr: GhPull;
  gate: { command: string; code: number | null; output: string } | null;
  overridden: boolean;
}

function runGate(dir: string, command: string) {
  const r = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8', env: process.env });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { command, code: r.status, output: output.length > 4000 ? `…${output.slice(-4000)}` : output };
}

/**
 * Move the PR out of draft only if the handoff gate passes, or with an override reason that is
 * written into the PR body under "Handoff override". Never merges.
 */
export async function readyForEngineering(ctx: GithubContext, cwd: string, o: ReadyOptions = {}): Promise<ReadyResult> {
  const { dir, r, pr } = await requirePr(ctx, cwd);
  if (!pr.draft) return { status: 'already-ready', pr, gate: null, overridden: false };
  const gate = runGate(dir, o.gate ?? DEFAULT_GATE);
  const passed = gate.code === 0;
  const reason = o.override?.trim();
  if (!passed && !reason) return { status: 'refused', pr, gate, overridden: false };

  let current = pr;
  if (!passed && reason) {
    const user = await resolveUser(ctx, dir).catch(() => 'unknown');
    const fence = '```';
    const entry = [
      `- **${new Date().toISOString().slice(0, 10)}**, @${user}: ${reason}`,
      `  Gate \`${gate.command}\` failed (exit ${gate.code ?? 'signal'}):`,
      `  ${fence}`,
      ...(gate.output || '(no output)').split('\n').slice(-30).map((l) => `  ${l}`),
      `  ${fence}`,
    ].join('\n');
    const prev = getSection(pr.body ?? '', 'override');
    const content = prev ? `${prev.trim()}\n${entry}` : `## Handoff override\nMarked ready for engineering although the handoff gate failed.\n\n${entry}`;
    current = await ctx.client.updatePull(r, pr.number, { body: setSection(pr.body ?? '', 'override', content) });
    say(ctx, `${short(r)}#${pr.number}: override recorded in the PR description`);
  }
  const res = await ctx.client.markReadyForReview(current);
  current = { ...current, draft: res.isDraft };
  if (o.reviewers?.length) await ctx.client.requestReviewers(r, pr.number, o.reviewers);
  say(ctx, `${short(r)}#${pr.number}: ready for engineering ${current.html_url}`);
  return { status: 'ready', pr: current, gate, overridden: !passed };
}

// ---------- branch from (FR-1103) ----------

export interface BranchList {
  repo: RepoRef;
  prototypes: { name: string; sha: string; pr: { number: number; url: string; draft: boolean } | null }[];
  branches: { name: string; sha: string; protected: boolean }[];
}

/** Prototype branches (with their open PR, if any) and every other branch the token can read. */
export async function listBranchSources(ctx: GithubContext, cwd: string): Promise<BranchList> {
  const r = originRepo(repoRoot(cwd));
  const [branches, pulls] = await Promise.all([ctx.client.listBranches(r), ctx.client.listOpenPulls(r)]);
  const byHead = new Map(pulls.filter((p) => p.head.label === `${r.owner}:${p.head.ref}`).map((p) => [p.head.ref, p]));
  return {
    repo: r,
    prototypes: branches
      .filter((b) => isProtoBranch(b.name))
      .map((b) => {
        const p = byHead.get(b.name);
        return { name: b.name, sha: b.commit.sha, pr: p ? { number: p.number, url: p.html_url, draft: p.draft } : null };
      }),
    branches: branches.filter((b) => !isProtoBranch(b.name)).map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected })),
  };
}

/**
 * New prototype branch proto/<user>/<slug> from any branch (a prototype or an engineer's branch):
 * created on GitHub at the source's head, then checked out locally. The source is recorded as
 * the PR base for `pr open`.
 */
export async function branchFrom(ctx: GithubContext, cwd: string, source: string, o: { slug?: string } = {}) {
  const dir = repoRoot(cwd);
  const r = originRepo(dir);
  if (isDirty(dir)) throw new Error('You have uncommitted changes. Save them (pr open) or stash them first.');
  const user = await resolveUser(ctx, dir);
  const slug = o.slug ?? `${parseProtoBranch(source)?.slug ?? source.split('/').pop()}-copy`;
  const branch = protoBranch(user, slug);
  if (branch === source) throw new Error(`"${branch}" is the source branch. Pick another --slug.`);
  const src = await ctx.client.getBranch(r, source);
  await ctx.client.createBranch(r, branch, src.commit.sha);
  git(dir, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  git(dir, ['checkout', '-q', '-b', branch, '--track', `origin/${branch}`]);
  recordBase(dir, branch, source);
  say(ctx, `${short(r)}: created ${branch} from ${source} (${src.commit.sha.slice(0, 7)}); PRs will target ${source}`);
  return { repo: r, branch, source, sha: src.commit.sha };
}

// ---------- multi-repo ----------

const ROLE_RANK: Record<string, number> = { library: 0, other: 1, app: 2 };

export interface WorkspacePr {
  name: string;
  role: string;
  repo: RepoRef;
  number: number;
  url: string;
  created: boolean;
}

export function relatedSection(branch: string, prs: WorkspacePr[], self: WorkspacePr): string {
  const lines = prs.map((p, i) => `${i + 1}. ${p.repo.owner}/${p.repo.repo}#${p.number} (${p.role}: ${p.name})${p === self ? ' ← this PR' : ''}`);
  return ['## Related PRs', `Prototype \`${branch}\` changes ${prs.length} repos. Merge in this order (libraries first; app PRs depend on them):`, '', ...lines].join('\n');
}

/**
 * One branch name across repos, one draft PR per changed writable repo, libraries first, each PR
 * body cross-linking the set ("Related PRs", rewritten on every run).
 */
export async function openWorkspacePrs(ctx: GithubContext, cwd: string, o: Omit<OpenOptions, 'branch' | 'related' | 'base'> = {}) {
  const file = findConfig(cwd);
  if (!file) throw new Error('No stagecraft.config.ts: --workspace runs in the host repo of a multi-repo product.');
  const { config, root } = await loadConfig(file);
  const repos = resolveWorkspace(root, config);
  const status = workspaceStatus(repos);

  const host = repos.find((x) => x.host)!;
  const hostBranch = currentBranch(host.abs);
  let branch: string;
  if (isProtoBranch(hostBranch)) branch = hostBranch;
  else {
    const slug = o.slug ?? (o.title ? sanitizeSlug(o.title) : '');
    if (!slug) throw new Error(`The host repo is on "${hostBranch}". Give the prototype a name: --slug <name> or --title "<title>".`);
    branch = protoBranch(await resolveUser(ctx, host.abs), slug);
  }

  const targets: { name: string; role: string; host: boolean; abs: string }[] = [];
  for (const rs of status) {
    const rr = repos.find((x) => x.name === rs.name)!;
    if (!rs.present || !rs.git || rs.readOnly) continue;
    let ref: RepoRef;
    try {
      ref = originRepo(rr.abs);
    } catch (e) {
      say(ctx, `! ${rs.name}: ${(e as Error).message}`);
      continue;
    }
    const info = await ctx.client.getRepo(ref);
    // Changed = uncommitted work, commits on the prototype branch, or a PR from an earlier run.
    const changed =
      rs.changedFiles.length > 0 ||
      (rs.branch === branch && commitsAhead(rr.abs, info.default_branch) > 0) ||
      (await ctx.client.findPullByHead(ref, branch)) !== null;
    if (changed) targets.push({ name: rs.name, role: rs.role, host: rr.host, abs: rr.abs });
    else say(ctx, `${rs.name}: no changes, no PR`);
  }
  if (!targets.length) throw new Error('No writable repo has changes. Nothing to open.');
  targets.sort((a, b) => (ROLE_RANK[a.role] ?? 1) - (ROLE_RANK[b.role] ?? 1) || Number(a.host) - Number(b.host) || a.name.localeCompare(b.name));

  const prs: WorkspacePr[] = [];
  const opened: OpenResult[] = [];
  for (const t of targets) {
    const res = await openPr(ctx, t.abs, { ...o, branch });
    opened.push(res);
    prs.push({ name: t.name, role: t.role, repo: res.repo, number: res.pr.number, url: res.pr.html_url, created: res.created });
  }
  // Second pass: every PR number is known now, so write the cross-links.
  for (let i = 0; i < prs.length; i++) {
    const res = opened[i]!;
    const old = res.pr.body ?? '';
    const body = setSection(old, 'related', relatedSection(branch, prs, prs[i]!));
    if (body !== old) await ctx.client.updatePull(res.repo, res.pr.number, { body });
  }
  return { branch, prs };
}
