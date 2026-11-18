import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appInstallationTokenProvider,
  GitHubClient,
  parseProtoBranch,
  parseRemoteUrl,
  protoBranch,
  registerGithubTools,
  sanitizeSlug,
  setSection,
  getSection,
  staticTokenProvider,
  withCoAuthor,
} from '@stagecraft/github';
import { FakeGitHub, type FakeRepo } from '../fake-github.ts';
import { multiRepoFixture, REPO } from '../helpers.ts';

/**
 * GitHub integration against a fake GitHub server (tests/fake-github.ts) and local bare git
 * remotes. Nothing here talks to github.com: origins use the unresolvable host
 * github.stagecraft.test, rewritten by `url.<bare>.insteadOf` to a local bare repo.
 */

const BIN = join(REPO, 'packages/cli/src/bin.ts');
const APP_TOKEN = 'ghs_fake_installation_token';
const PAT = 'ghp_fake_personal_token';
const FAKE_HOST = 'github.stagecraft.test';
const CO_AUTHOR = 'Co-authored-by: Claude <noreply@anthropic.com>';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let fake: FakeGitHub;

function sc(cwd: string, args: string[], env: Record<string, string> = {}) {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), GITHUB_TOKEN: APP_TOKEN, STAGECRAFT_GITHUB_API_URL: fake.url, ...env };
  delete e.GH_TOKEN;
  delete e.STAGECRAFT_USER;
  delete e.STAGECRAFT_CO_AUTHOR;
  // Async: the fake server lives in this process, so a sync spawn would deadlock.
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    const c = spawn('node', [BIN, ...args], { cwd, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (status) => resolve({ status, out }));
  });
}

function tmpRoot(name: string) {
  const root = join(REPO, 'tests/.tmp', `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Give a work repo an origin on the fake host, backed by a new local bare repo. */
function attachRemote(work: string, root: string, owner: string, repo: string): FakeRepo {
  const bare = join(root, 'remotes', owner, `${repo}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const url = `https://${FAKE_HOST}/${owner}/${repo}.git`;
  git(work, 'remote', 'add', 'origin', url);
  git(work, 'config', `url.${bare}.insteadOf`, url);
  git(work, 'config', 'user.name', 'Dana Designer');
  git(work, 'config', 'user.email', 'dana@example.com');
  git(work, 'push', '-q', 'origin', 'main');
  return { owner, repo, bare, protectedBranches: ['main'] };
}

function newWorkRepo(root: string, name: string) {
  const work = join(root, name);
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src/app.ts'), 'export const app = 1;\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, '-c', 'user.name=Eng', '-c', 'user.email=eng@example.com', 'add', '-A');
  git(work, '-c', 'user.name=Eng', '-c', 'user.email=eng@example.com', 'commit', '-qm', 'init');
  return work;
}

const posts = (path: RegExp) => fake.log.filter((l) => l.method === 'POST' && path.test(l.path));

afterAll(async () => {
  await fake?.close();
});

describe('prototype naming', () => {
  it('builds and parses proto/<user>/<slug> with sanitized parts', async () => {
    expect(protoBranch('Dana Designer', 'New Agent Controls!')).toBe('proto/dana-designer/new-agent-controls');
    expect(protoBranch('octo', '  Café  — résumé / v2 ')).toBe('proto/octo/cafe-resume-v2');
    expect(sanitizeSlug('a'.repeat(80))).toHaveLength(60);
    expect(() => protoBranch('dana', '!!!')).toThrow(/slug/);
    expect(parseProtoBranch('proto/dana-designer/new-agent-controls')).toEqual({ user: 'dana-designer', slug: 'new-agent-controls' });
    expect(parseProtoBranch('feature/x')).toBeNull();
  });

  it('reads owner/repo from https and ssh remotes', async () => {
    expect(parseRemoteUrl('https://github.com/acme/web.git')).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'web' });
    expect(parseRemoteUrl('https://x-access-token:abc@github.com/acme/web')).toMatchObject({ owner: 'acme', repo: 'web' });
    expect(parseRemoteUrl('git@github.com:acme/design-system.git')).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'design-system' });
    expect(parseRemoteUrl('ssh://git@github.com/acme/web.git')).toMatchObject({ owner: 'acme', repo: 'web' });
    expect(parseRemoteUrl('ssh://git@github.com:22/acme/web.git')).toMatchObject({ owner: 'acme', repo: 'web' });
    expect(parseRemoteUrl('/tmp/remotes/web.git')).toBeNull();
  });

  it('adds the co-author trailer once', async () => {
    const m = withCoAuthor('Save prototype');
    expect(m).toBe(`Save prototype\n\n${CO_AUTHOR}\n`);
    expect(withCoAuthor(m)).toBe(m);
  });

  it('rewrites managed PR body sections in place', async () => {
    let b = setSection('Hello', 'related', '## Related PRs\n1. a');
    b = setSection(b, 'related', '## Related PRs\n1. b');
    expect(b.match(/Related PRs/g)).toHaveLength(1);
    expect(getSection(b, 'related')).toContain('1. b');
    expect(b.startsWith('Hello\n')).toBe(true);
  });
});

describe('single repo: draft PR, preview comment, check, ready gate', () => {
  let root: string;
  let work: string;
  const BRANCH = 'proto/dana-designer/new-agent-controls';

  beforeAll(async () => {
    root = tmpRoot('gh');
    work = newWorkRepo(root, 'web');
    const remote = attachRemote(work, root, 'acme', 'web');
    fake = await new FakeGitHub([remote]).start();
  });

  it('pr open: new proto branch, human-authored co-authored commit, push, draft PR with label', async () => {
    writeFileSync(join(work, 'src/controls.ts'), 'export const controls = true;\n');
    const r = await sc(work, ['pr', 'open', '--title', 'New agent controls']);
    expect(r.out).toMatch(/opened draft PR #1/);
    expect(r.status).toBe(0);
    // App installation tokens cannot call GET /user, so the user falls back to git user.name.
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(git(work, 'log', '-1', '--format=%an <%ae>|%cn')).toBe('Dana Designer <dana@example.com>|Dana Designer');
    expect(git(work, 'log', '-1', '--format=%B')).toContain(CO_AUTHOR);
    expect(git(work, 'log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)')).toBe('Claude <noreply@anthropic.com>');
    const bare = fake.repo('acme/web').cfg.bare;
    expect(git(bare, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(git(work, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(`origin/${BRANCH}`);

    const prs = fake.pulls('acme/web');
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ draft: true, head: BRANCH, base: 'main', title: 'New agent controls', labels: ['stagecraft-prototype'] });
    expect(fake.repo('acme/web').labels.get('stagecraft-prototype')).toMatchObject({ color: '7c3aed' });
    expect(posts(/\/labels$/).filter((l) => l.path === '/repos/acme/web/labels')).toHaveLength(1); // label created once
  });

  it('pr open again updates the same PR instead of opening a second one', async () => {
    writeFileSync(join(work, 'src/controls.ts'), 'export const controls = 2;\n');
    const bodyFile = join(root, 'body.md');
    writeFileSync(bodyFile, '## Summary\nAgent controls, second pass.\n');
    let r = await sc(work, ['pr', 'open', '--title', 'Agent controls v2', '--body-file', bodyFile]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/updated PR #1/);
    r = await sc(work, ['pr', 'open']); // nothing new: still fine, still one PR
    expect(r.status).toBe(0);
    const prs = fake.pulls('acme/web');
    expect(prs).toHaveLength(1);
    expect(prs[0]!.title).toBe('Agent controls v2');
    expect(prs[0]!.body).toBe('## Summary\nAgent controls, second pass.');
    expect(posts(/^\/repos\/acme\/web\/pulls$/)).toHaveLength(1);
    expect(git(fake.repo('acme/web').cfg.bare, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(git(work, 'rev-list', '--count', 'main..HEAD')).toBe('2');
  });

  it('pr comment upserts one preview comment and one check run per head commit', async () => {
    const notes = join(root, 'notes.md');
    writeFileSync(notes, 'States: empty, frozen account.');
    let r = await sc(work, ['pr', 'comment', '--preview-url', 'https://preview.example/p/1', '--screenshot', 'https://img.example/matrix-1.png', '--body-file', notes]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/posted preview comment/);
    const st = fake.repo('acme/web');
    expect(st.comments).toHaveLength(1);
    expect(st.checks).toHaveLength(1);

    writeFileSync(notes, 'States: empty, frozen account, overdue.');
    r = await sc(work, ['pr', 'comment', '--preview-url', 'https://preview.example/p/2', '--screenshot', 'https://img.example/matrix-2.png', '--body-file', notes]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/updated preview comment/);
    expect(st.comments).toHaveLength(1);
    expect(st.comments[0]!.body).toContain('<!-- stagecraft:preview -->');
    expect(st.comments[0]!.body).toContain('https://preview.example/p/2');
    expect(st.comments[0]!.body).toContain('![State matrix](https://img.example/matrix-2.png)');
    expect(st.comments[0]!.body).toContain('overdue');
    expect(st.checks).toHaveLength(1); // same head SHA: updated
    expect(st.checks[0]).toMatchObject({ name: 'Stagecraft', status: 'completed', conclusion: 'success', details_url: 'https://preview.example/p/2', head_sha: git(work, 'rev-parse', 'HEAD') });
    expect(st.checks[0]!.output.images[0].image_url).toBe('https://img.example/matrix-2.png');

    // A new push: the comment is edited again, a new check run goes on the new head.
    writeFileSync(join(work, 'src/controls.ts'), 'export const controls = 3;\n');
    expect((await sc(work, ['pr', 'open'])).status).toBe(0);
    expect((await sc(work, ['pr', 'comment', '--preview-url', 'https://preview.example/p/3'])).status).toBe(0);
    expect(st.comments).toHaveLength(1);
    expect(st.comments[0]!.body).toContain(git(work, 'rev-parse', '--short=7', 'HEAD'));
    expect(st.checks).toHaveLength(2);
    expect(st.checks[1]!.head_sha).toBe(git(work, 'rev-parse', 'HEAD'));
  });

  it('pr comment can reference a committed screenshot file', async () => {
    mkdirSync(join(work, 'stagecraft/screenshots'), { recursive: true });
    writeFileSync(join(work, 'stagecraft/screenshots/matrix.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await sc(work, ['pr', 'comment', '--screenshot', 'stagecraft/screenshots/matrix.png'])).out).toMatch(/not in the pushed commit/);
    expect((await sc(work, ['pr', 'open', '--message', 'Add state matrix'])).status).toBe(0);
    expect((await sc(work, ['pr', 'comment', '--screenshot', 'stagecraft/screenshots/matrix.png'])).status).toBe(0);
    const sha = git(work, 'rev-parse', 'HEAD');
    expect(fake.repo('acme/web').comments[0]!.body).toContain(`https://${FAKE_HOST}/acme/web/blob/${sha}/stagecraft/screenshots/matrix.png?raw=true`);
  });

  it('with a personal access token the check is skipped but the comment still updates', async () => {
    const r = await sc(work, ['pr', 'comment', '--preview-url', 'https://preview.example/p/4'], { GITHUB_TOKEN: PAT });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Check run skipped/);
    expect(fake.repo('acme/web').comments).toHaveLength(1);
    expect(fake.repo('acme/web').comments[0]!.body).toContain('/p/4');
  });

  it('pr status shows the PR, comment and check', async () => {
    const r = await sc(work, ['pr', 'status']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/acme\/web#1 draft: Agent controls v2/);
    expect(r.out).toMatch(/labels: stagecraft-prototype/);
    expect(r.out).toMatch(/preview comment: https:\/\/github.com\/acme\/web\/pull\/1#issuecomment-/);
    expect(r.out).toMatch(/check: Stagecraft success/);
    const j = JSON.parse((await sc(work, ['pr', 'status', '--json'])).out);
    expect(j.pr.number).toBe(1);
  });

  const FAILING_GATE = `node -e "console.log('variant agent-list-layout still in src/Agents.tsx'); process.exit(1)"`;

  it('pr ready refuses when the handoff gate fails and there is no override', async () => {
    const r = await sc(work, ['pr', 'ready', '--gate', FAILING_GATE]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Not ready for engineering/);
    expect(r.out).toMatch(/variant agent-list-layout still in src\/Agents.tsx/);
    expect(r.out).toMatch(/--override/);
    expect(fake.pulls('acme/web')[0]!.draft).toBe(true);
    expect(posts(/^\/graphql$/)).toHaveLength(0);
  });

  it('pr ready --override records the reason in the PR and marks it ready (GraphQL)', async () => {
    const r = await sc(work, ['pr', 'ready', '--gate', FAILING_GATE, '--override', 'Exec demo on Friday; variant cleanup is ticket ENG-42']);
    expect(r.status).toBe(0);
    const pr = fake.pulls('acme/web')[0]!;
    expect(pr.draft).toBe(false);
    expect(pr.body).toContain('## Handoff override');
    expect(pr.body).toContain('Exec demo on Friday; variant cleanup is ticket ENG-42');
    expect(pr.body).toContain('variant agent-list-layout still in src/Agents.tsx');
    expect(pr.body).toContain('## Summary'); // the user's description is kept
    const gql = posts(/^\/graphql$/);
    expect(gql).toHaveLength(1);
    expect(gql[0]!.body.query).toContain('markPullRequestReadyForReview');
    expect(gql[0]!.body.variables.id).toBe(pr.node_id);
    expect((await sc(work, ['pr', 'ready', '--gate', FAILING_GATE])).out).toMatch(/already ready/);
  });

  it('branch-from lists sources and starts a prototype from an engineer branch', async () => {
    git(work, 'checkout', '-q', '-b', 'feature/eng-table', 'main');
    writeFileSync(join(work, 'src/table.ts'), 'export const table = 1;\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'Engineer work');
    git(work, 'push', '-q', 'origin', 'feature/eng-table');

    const l = await sc(work, ['branch-from', 'list']);
    expect(l.status).toBe(0);
    expect(l.out).toMatch(/Prototypes:\n {2}proto\/dana-designer\/new-agent-controls {2}#1 https:\/\/github.com\/acme\/web\/pull\/1/);
    expect(l.out).toMatch(/feature\/eng-table/);
    expect(l.out).toMatch(/main {2}\(protected\)/);

    const r = await sc(work, ['branch-from', 'feature/eng-table', '--slug', 'table tweaks']);
    expect(r.status).toBe(0);
    const NEW = 'proto/dana-designer/table-tweaks';
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(NEW);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(git(work, 'rev-parse', 'feature/eng-table'));
    expect(posts(/\/git\/refs$/)[0]!.body).toEqual({ ref: `refs/heads/${NEW}`, sha: git(work, 'rev-parse', 'feature/eng-table') });

    writeFileSync(join(work, 'src/table.ts'), 'export const table = 2;\n');
    expect((await sc(work, ['pr', 'open'])).status).toBe(0);
    const pr = fake.pulls('acme/web').find((p) => p.head === NEW)!;
    expect(pr).toMatchObject({ base: 'feature/eng-table', draft: true, title: 'Table tweaks' });

    // The gate passes: ready, with no override section.
    expect((await sc(work, ['pr', 'ready', '--gate', 'node -e 0'])).status).toBe(0);
    expect(pr.draft).toBe(false);
    expect(pr.body).not.toContain('Handoff override');
  });

  it('uses the GitHub login for the branch name when the token is a user token', async () => {
    git(work, 'checkout', '-q', 'main');
    writeFileSync(join(work, 'src/login.ts'), 'export {};\n');
    expect((await sc(work, ['pr', 'open', '--slug', 'login-page'], { GITHUB_TOKEN: PAT })).status).toBe(0);
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('proto/octo-designer/login-page');
  });

  it('refuses to work on the base branch without a name', async () => {
    git(work, 'checkout', '-q', 'main');
    writeFileSync(join(work, 'src/x.ts'), 'export {};\n');
    const r = await sc(work, ['pr', 'open']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/--slug/);
    git(work, 'clean', '-fdq', 'src');
  });

  it('never attempted a merge', async () => {
    expect(fake.mergeAttempts).toEqual([]);
  });
});

describe('multi-repo: one branch, one PR per changed repo, libraries first, cross-linked', () => {
  let fx: ReturnType<typeof multiRepoFixture>;

  beforeAll(async () => {
    fx = multiRepoFixture({ web: 5981, admin: 5982 });
    const remotes = [attachRemote(fx.web, fx.root, 'acme', 'web'), attachRemote(fx.ui, fx.root, 'acme', 'ui'), attachRemote(fx.admin, fx.root, 'acme', 'admin'), attachRemote(fx.api, fx.root, 'acme', 'api')];
    await fake?.close();
    fake = await new FakeGitHub(remotes).start();
  });

  it('opens the library PR first, then the app PR, each linking the other', async () => {
    writeFileSync(join(fx.ui, 'src/Pill.tsx'), 'export const Pill = () => null;\n');
    writeFileSync(join(fx.web, 'src/extra.ts'), 'export {};\n');
    const r = await sc(fx.web, ['pr', 'open', '--workspace', '--slug', 'pill-badge', '--title', 'Pill badge']);
    expect(r.out).toMatch(/2 PRs/);
    expect(r.status).toBe(0);
    const BR = 'proto/dana-designer/pill-badge';
    for (const d of [fx.web, fx.ui]) expect(git(d, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BR);
    expect(git(fx.admin, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fake.pulls('acme/admin')).toHaveLength(0);
    expect(fake.pulls('acme/api')).toHaveLength(0); // read-only

    const created = posts(/^\/repos\/acme\/[^/]+\/pulls$/).map((l) => l.path);
    expect(created).toEqual(['/repos/acme/ui/pulls', '/repos/acme/web/pulls']);
    const ui = fake.pulls('acme/ui')[0]!;
    const web = fake.pulls('acme/web')[0]!;
    for (const p of [ui, web]) {
      expect(p).toMatchObject({ head: BR, draft: true, labels: ['stagecraft-prototype'], title: 'Pill badge' });
      expect(p.body).toMatch(/## Related PRs[\s\S]*1\. acme\/ui#1 \(library: ui\)[\s\S]*2\. acme\/web#1 \(app: \(host\)\)/);
    }
    expect(ui.body).toMatch(/acme\/ui#1 \(library: ui\) ← this PR/);
    expect(web.body).toMatch(/acme\/web#1 \(app: \(host\)\) ← this PR/);
    expect(git(fx.ui, 'log', '-1', '--format=%B')).toContain(CO_AUTHOR);
  });

  it('a re-run adds newly changed repos and rewrites the links in every PR, without duplicates', async () => {
    writeFileSync(join(fx.admin, 'src/new.ts'), 'export {};\n');
    const r = await sc(fx.web, ['pr', 'open', '--workspace']);
    expect(r.status).toBe(0);
    expect(fake.pulls('acme/ui')).toHaveLength(1);
    expect(fake.pulls('acme/web')).toHaveLength(1);
    expect(fake.pulls('acme/admin')).toHaveLength(1);
    expect(git(fx.admin, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('proto/dana-designer/pill-badge');
    for (const full of ['acme/ui', 'acme/admin', 'acme/web']) {
      const body = fake.pulls(full)[0]!.body!;
      expect(body.match(/## Related PRs/g)).toHaveLength(1);
      expect(body).toMatch(/1\. acme\/ui#1 \(library: ui\)[^\n]*\n2\. acme\/admin#1 \(app: admin\)[^\n]*\n3\. acme\/web#1 \(app: \(host\)\)/);
    }
    expect(fake.mergeAttempts).toEqual([]);
  });
});

describe('client details', () => {
  it('follows Link pagination', async () => {
    const root = tmpRoot('gh-page');
    const work = newWorkRepo(root, 'web');
    const remote = attachRemote(work, root, 'acme', 'web');
    for (const b of ['a', 'b', 'c']) git(work, 'push', '-q', 'origin', `main:refs/heads/${b}`);
    const f = await new FakeGitHub([remote]).start();
    try {
      const c = new GitHubClient({ baseUrl: f.url, token: staticTokenProvider(APP_TOKEN), perPage: 2 });
      expect((await c.listBranches({ owner: 'acme', repo: 'web' })).map((b) => b.name)).toEqual(['a', 'b', 'c', 'main']);
      expect(f.log.filter((l) => l.path.includes('/branches')).length).toBe(2);
    } finally {
      await f.close();
    }
  });

  it('GitHub App: exchanges a signed JWT for an installation token and caches it', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const root = tmpRoot('gh-app');
    const work = newWorkRepo(root, 'web');
    const f = await new FakeGitHub([attachRemote(work, root, 'acme', 'web')], { appId: '4242', appPublicKey: publicKey }).start();
    try {
      const c = new GitHubClient({ baseUrl: f.url, token: appInstallationTokenProvider({ appId: '4242', privateKey, installationId: 77 }, { baseUrl: f.url }) });
      expect((await c.getRepo({ owner: 'acme', repo: 'web' })).default_branch).toBe('main');
      await c.getRepo({ owner: 'acme', repo: 'web' });
      expect(f.issuedTokens).toEqual(['ghs_installation_77_0']);
      const exchange = f.log.find((l) => l.path.includes('/access_tokens'))!;
      expect(exchange.body.permissions).toEqual({ contents: 'write', pull_requests: 'write', checks: 'write', metadata: 'read' });
      const other = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const bad = new GitHubClient({ baseUrl: f.url, token: appInstallationTokenProvider({ appId: '4242', privateKey: other.privateKey, installationId: 77 }, { baseUrl: f.url }) });
      await expect(bad.getRepo({ owner: 'acme', repo: 'web' })).rejects.toThrow(/token exchange failed \(HTTP 401\)/);
    } finally {
      await f.close();
    }
  });

  it('registers MCP tools with valid names and no merge tool', async () => {
    const tools = new Map<string, (a: any) => Promise<unknown>>();
    const root = tmpRoot('gh-mcp');
    const work = newWorkRepo(root, 'web');
    const f = await new FakeGitHub([attachRemote(work, root, 'acme', 'web')]).start();
    try {
      registerGithubTools((name, _d, _s, fn) => tools.set(name, fn as any), { cwd: work, client: new GitHubClient({ baseUrl: f.url, token: staticTokenProvider(APP_TOKEN) }) });
      expect([...tools.keys()].sort()).toEqual(['github_branch_from', 'github_branch_list', 'github_pr_comment', 'github_pr_open', 'github_pr_ready', 'github_pr_status']);
      for (const n of tools.keys()) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      writeFileSync(join(work, 'src/mcp.ts'), 'export {};\n');
      const opened: any = await tools.get('github_pr_open')!({ slug: 'from-mcp' });
      expect(opened).toMatchObject({ branch: 'proto/dana-designer/from-mcp', number: 1, draft: true, created: true });
      const status: any = await tools.get('github_pr_status')!({});
      expect(status.pr).toMatchObject({ number: 1, draft: true, labels: ['stagecraft-prototype'] });
    } finally {
      await f.close();
    }
  });
});

describe('FR-1108: Stagecraft never merges', () => {
  it('no package source uses the merge API', async () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(c|m)?[jt]sx?$|\.json$|\.md$/.test(e)) {
          readFileSync(p, 'utf8')
            .split('\n')
            .forEach((line, i) => {
              if (/\/merge\b|mergePullRequest|merge_method/.test(line)) offenders.push(`${p.slice(REPO.length + 1)}:${i + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk(join(REPO, 'packages'));
    expect(offenders).toEqual([]);
  });

  it('the client has no merge method', async () => {
    const methods = Object.getOwnPropertyNames(GitHubClient.prototype);
    expect(methods).toContain('markReadyForReview');
    expect(methods.filter((m) => /merge/i.test(m))).toEqual([]);
  });
});
