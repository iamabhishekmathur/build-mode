import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake GitHub REST + GraphQL server for tests. Never talks to github.com.
 *
 * Each repo is backed by a local bare git repo, so branches, SHAs and "no commits between"
 * come from real git data, and `git push` (to the bare repo) is visible to the API.
 * Response shapes follow the GitHub REST docs (API version 2022-11-28), trimmed to the fields
 * Stagecraft reads plus the usual identifiers.
 */

export interface FakeRepo {
  owner: string;
  repo: string;
  bare: string;
  private?: boolean;
  /** Branches GitHub reports as protected. */
  protectedBranches?: string[];
}

export interface Logged {
  method: string;
  path: string;
  body: any;
}

interface Pull {
  id: number;
  node_id: string;
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  title: string;
  body: string | null;
  head: string;
  base: string;
  labels: string[];
  requested_reviewers: string[];
  created_at: string;
  updated_at: string;
}

interface Comment {
  id: number;
  issue: number;
  body: string;
  created_at: string;
  updated_at: string;
}

interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  output: any;
}

interface RepoState {
  cfg: FakeRepo;
  id: number;
  pulls: Pull[];
  labels: Map<string, { id: number; name: string; color: string; description: string | null }>;
  comments: Comment[];
  checks: CheckRun[];
}

export interface FakeGitHubOptions {
  /** Tokens that act like GitHub App installation tokens (ghs_…): may create check runs. */
  appTokens?: string[];
  /** Tokens that act like personal access tokens: everything except check runs (403). */
  patTokens?: string[];
  viewer?: string;
  /** PEM public key of the fake GitHub App, to verify JWTs on the token exchange. */
  appPublicKey?: string;
  appId?: string;
}

let seq = 1000;
const now = () => new Date().toISOString();

export class FakeGitHub {
  repos = new Map<string, RepoState>();
  log: Logged[] = [];
  mergeAttempts: Logged[] = [];
  server: http.Server;
  url = '';
  opts: Required<Omit<FakeGitHubOptions, 'appPublicKey' | 'appId'>> & Pick<FakeGitHubOptions, 'appPublicKey' | 'appId'>;
  issuedTokens: string[] = [];

  constructor(repos: FakeRepo[], opts: FakeGitHubOptions = {}) {
    this.opts = { appTokens: opts.appTokens ?? ['ghs_fake_installation_token'], patTokens: opts.patTokens ?? ['ghp_fake_personal_token'], viewer: opts.viewer ?? 'octo-designer', appPublicKey: opts.appPublicKey, appId: opts.appId };
    for (const r of repos) this.addRepo(r);
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: any = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          return this.#send(res, 400, { message: 'Problems parsing JSON' });
        }
        try {
          this.#handle(req, res, body);
        } catch (e) {
          this.#send(res, 500, { message: (e as Error).message });
        }
      });
    });
  }

  addRepo(cfg: FakeRepo) {
    this.repos.set(`${cfg.owner}/${cfg.repo}`.toLowerCase(), { cfg, id: seq++, pulls: [], labels: new Map(), comments: [], checks: [] });
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  repo(full: string) {
    return this.repos.get(full.toLowerCase())!;
  }

  pulls(full: string) {
    return this.repo(full).pulls;
  }

  // ---------- git (bare repo) ----------

  #git(st: RepoState, args: string[]): string | null {
    try {
      return execFileSync('git', args, { cwd: st.cfg.bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      return null;
    }
  }

  #defaultBranch(st: RepoState) {
    return (this.#git(st, ['symbolic-ref', '--short', 'HEAD']) ?? 'main').replace(/^refs\/heads\//, '');
  }

  #sha(st: RepoState, branch: string) {
    return this.#git(st, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  }

  #branches(st: RepoState) {
    const out = this.#git(st, ['for-each-ref', 'refs/heads', '--format=%(refname:short) %(objectname)']) ?? '';
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, sha] = l.split(' ');
        return { name: name!, sha: sha! };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- JSON shapes ----------

  #repoJson(st: RepoState) {
    const { owner, repo } = st.cfg;
    return {
      id: st.id,
      node_id: `R_${st.id}`,
      name: repo,
      full_name: `${owner}/${repo}`,
      owner: { login: owner, id: 1, type: 'Organization' },
      private: st.cfg.private ?? true,
      html_url: `https://github.com/${owner}/${repo}`,
      default_branch: this.#defaultBranch(st),
      permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    };
  }

  #branchJson(st: RepoState, b: { name: string; sha: string }) {
    const { owner, repo } = st.cfg;
    return { name: b.name, commit: { sha: b.sha, url: `https://api.github.com/repos/${owner}/${repo}/commits/${b.sha}` }, protected: !!st.cfg.protectedBranches?.includes(b.name) };
  }

  #labelJson(st: RepoState, name: string) {
    const l = st.labels.get(name.toLowerCase())!;
    return { id: l.id, node_id: `LA_${l.id}`, url: `https://api.github.com/repos/${st.cfg.owner}/${st.cfg.repo}/labels/${encodeURIComponent(l.name)}`, name: l.name, color: l.color, default: false, description: l.description };
  }

  #pullJson(st: RepoState, p: Pull) {
    const { owner, repo } = st.cfg;
    const full = `${owner}/${repo}`;
    return {
      url: `https://api.github.com/repos/${full}/pulls/${p.number}`,
      id: p.id,
      node_id: p.node_id,
      html_url: `https://github.com/${full}/pull/${p.number}`,
      number: p.number,
      state: p.state,
      locked: false,
      title: p.title,
      user: { login: this.opts.viewer, id: 7, type: 'User' },
      body: p.body,
      labels: p.labels.map((n) => this.#labelJson(st, n)),
      draft: p.draft,
      created_at: p.created_at,
      updated_at: p.updated_at,
      requested_reviewers: p.requested_reviewers.map((login) => ({ login, type: 'User' })),
      head: { label: `${owner}:${p.head}`, ref: p.head, sha: this.#sha(st, p.head) ?? '0'.repeat(40), repo: { full_name: full } },
      base: { label: `${owner}:${p.base}`, ref: p.base, sha: this.#sha(st, p.base) ?? '0'.repeat(40), repo: { full_name: full } },
    };
  }

  #commentJson(st: RepoState, c: Comment) {
    const full = `${st.cfg.owner}/${st.cfg.repo}`;
    return {
      id: c.id,
      node_id: `IC_${c.id}`,
      url: `https://api.github.com/repos/${full}/issues/comments/${c.id}`,
      html_url: `https://github.com/${full}/pull/${c.issue}#issuecomment-${c.id}`,
      issue_url: `https://api.github.com/repos/${full}/issues/${c.issue}`,
      body: c.body,
      user: { login: this.opts.viewer, id: 7, type: 'User' },
      created_at: c.created_at,
      updated_at: c.updated_at,
      author_association: 'MEMBER',
    };
  }

  #checkJson(st: RepoState, c: CheckRun) {
    const full = `${st.cfg.owner}/${st.cfg.repo}`;
    return { id: c.id, node_id: `CR_${c.id}`, name: c.name, head_sha: c.head_sha, status: c.status, conclusion: c.conclusion, details_url: c.details_url, html_url: `https://github.com/${full}/runs/${c.id}`, output: { title: c.output?.title ?? null, summary: c.output?.summary ?? null, text: c.output?.text ?? null, annotations_count: 0 }, app: { slug: 'stagecraft' } };
  }

  // ---------- routing ----------

  #send(res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-github-api-version-selected': '2022-11-28', ...headers });
    res.end(status === 204 ? '' : JSON.stringify(data));
  }

  #validation(res: http.ServerResponse, message: string, errors: unknown[] = []) {
    this.#send(res, 422, { message: 'Validation Failed', errors: errors.length ? errors : [{ resource: 'PullRequest', code: 'custom', message }], documentation_url: 'https://docs.github.com/rest', status: '422' });
  }

  #paged<T>(req: http.IncomingMessage, res: http.ServerResponse, url: URL, items: T[]) {
    const per = Math.min(Number(url.searchParams.get('per_page') ?? 30), 100);
    const page = Number(url.searchParams.get('page') ?? 1);
    const slice = items.slice((page - 1) * per, page * per);
    const headers: Record<string, string> = {};
    if (page * per < items.length) {
      const next = new URL(url.href);
      next.searchParams.set('page', String(page + 1));
      headers.link = `<${this.url}${next.pathname}${next.search}>; rel="next"`;
    }
    this.#send(res, 200, slice, headers);
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse, body: any) {
    const url = new URL(req.url!, 'http://x');
    const method = req.method!;
    const path = decodeURIComponent(url.pathname);
    const entry = { method, path: url.pathname + url.search, body };
    this.log.push(entry);

    // FR-1108 tripwire: Stagecraft must never call the merge endpoint.
    if (/\/pulls\/\d+\/merge$/.test(url.pathname) || /mergePullRequest/.test(JSON.stringify(body ?? ''))) {
      this.mergeAttempts.push(entry);
      return this.#send(res, 405, { message: 'Merge attempted in a test: Stagecraft must never merge' });
    }

    // GitHub App token exchange: Bearer <JWT>.
    let m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (m && method === 'POST') {
      const jwt = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const [h, p, s] = jwt.split('.');
      const ok = !!(this.opts.appPublicKey && h && p && s && verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(this.opts.appPublicKey), Buffer.from(s, 'base64url')));
      const claims = ok ? JSON.parse(Buffer.from(p!, 'base64url').toString()) : null;
      const t = Math.floor(Date.now() / 1000);
      if (!ok || claims.iss !== this.opts.appId || claims.exp <= t || claims.exp - claims.iat > 600) return this.#send(res, 401, { message: 'A JSON web token could not be decoded' });
      const token = `ghs_installation_${m[1]}_${this.issuedTokens.length}`;
      this.issuedTokens.push(token);
      this.opts.appTokens.push(token);
      return this.#send(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body?.permissions ?? {}, repository_selection: 'selected' });
    }

    const token = (req.headers.authorization ?? '').replace(/^(Bearer|token) /, '');
    const isApp = this.opts.appTokens.includes(token);
    if (!isApp && !this.opts.patTokens.includes(token)) return this.#send(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' });

    if (path === '/graphql' && method === 'POST') return this.#graphql(res, body);
    if (path === '/user' && method === 'GET') {
      if (isApp) return this.#send(res, 403, { message: 'Resource not accessible by integration' });
      return this.#send(res, 200, { login: this.opts.viewer, id: 7, name: 'Octo Designer', type: 'User' });
    }

    m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return this.#send(res, 404, { message: 'Not Found' });
    const st = this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
    if (!st) return this.#send(res, 404, { message: 'Not Found' });
    const rest = m[3] ?? '';
    const { owner } = st.cfg;

    if (rest === '' && method === 'GET') return this.#send(res, 200, this.#repoJson(st));

    if (rest === '/branches' && method === 'GET') return this.#paged(req, res, url, this.#branches(st).map((b) => this.#branchJson(st, b)));
    m = /^\/branches\/(.+)$/.exec(rest);
    if (m && method === 'GET') {
      const sha = this.#sha(st, m[1]!);
      return sha ? this.#send(res, 200, this.#branchJson(st, { name: m[1]!, sha })) : this.#send(res, 404, { message: 'Branch not found' });
    }

    if (rest === '/git/refs' && method === 'POST') {
      const ref = String(body?.ref ?? '');
      if (!ref.startsWith('refs/heads/')) return this.#validation(res, 'Reference name is invalid');
      if (this.#git(st, ['cat-file', '-e', `${body.sha}^{commit}`]) === null) return this.#validation(res, 'Object does not exist');
      if (this.#sha(st, ref.slice(11))) return this.#validation(res, 'Reference already exists');
      this.#git(st, ['update-ref', ref, body.sha]);
      return this.#send(res, 201, { ref, node_id: `REF_${seq++}`, url: `https://api.github.com/repos/${owner}/${st.cfg.repo}/git/${ref}`, object: { sha: body.sha, type: 'commit' } });
    }

    if (rest === '/pulls' && method === 'GET') {
      const head = url.searchParams.get('head');
      const state = url.searchParams.get('state') ?? 'open';
      const list = st.pulls.filter((p) => (state === 'all' || p.state === state) && (!head || `${owner}:${p.head}` === head)).sort((a, b) => b.number - a.number);
      return this.#paged(req, res, url, list.map((p) => this.#pullJson(st, p)));
    }
    if (rest === '/pulls' && method === 'POST') {
      const { title, head, base, draft } = body ?? {};
      if (!title) return this.#validation(res, 'title is missing', [{ resource: 'PullRequest', field: 'title', code: 'missing_field' }]);
      if (!this.#sha(st, head)) return this.#validation(res, 'head invalid', [{ resource: 'PullRequest', field: 'head', code: 'invalid' }]);
      if (!this.#sha(st, base)) return this.#validation(res, 'base invalid', [{ resource: 'PullRequest', field: 'base', code: 'invalid' }]);
      if (st.pulls.some((p) => p.state === 'open' && p.head === head && p.base === base)) return this.#validation(res, `A pull request already exists for ${owner}:${head}.`);
      if (this.#git(st, ['rev-list', '--count', `refs/heads/${base}..refs/heads/${head}`]) === '0') return this.#validation(res, `No commits between ${base} and ${head}`);
      const number = st.pulls.length + 1; // (no issues in the fake, so PR numbers start at 1)
      const id = seq++;
      const p: Pull = { id, node_id: `PR_kw${id}`, number, state: 'open', draft: !!draft, title, body: body.body ?? null, head, base, labels: [], requested_reviewers: [], created_at: now(), updated_at: now() };
      st.pulls.push(p);
      return this.#send(res, 201, this.#pullJson(st, p));
    }
    m = /^\/pulls\/(\d+)(\/requested_reviewers)?$/.exec(rest);
    if (m) {
      const p = st.pulls.find((x) => x.number === Number(m![1]));
      if (!p) return this.#send(res, 404, { message: 'Not Found' });
      if (!m[2] && method === 'GET') return this.#send(res, 200, this.#pullJson(st, p));
      if (!m[2] && method === 'PATCH') {
        // Like GitHub: `draft` is not an updatable field over REST (silently ignored).
        if (typeof body?.title === 'string') p.title = body.title;
        if (typeof body?.body === 'string') p.body = body.body;
        if (body?.state === 'closed' || body?.state === 'open') p.state = body.state;
        p.updated_at = now();
        return this.#send(res, 200, this.#pullJson(st, p));
      }
      if (m[2] && method === 'POST') {
        for (const r of body?.reviewers ?? []) if (!p.requested_reviewers.includes(r)) p.requested_reviewers.push(r);
        return this.#send(res, 201, this.#pullJson(st, p));
      }
    }

    m = /^\/labels\/(.+)$/.exec(rest);
    if (m && method === 'GET') return st.labels.has(m[1]!.toLowerCase()) ? this.#send(res, 200, this.#labelJson(st, m[1]!)) : this.#send(res, 404, { message: 'Not Found' });
    if (rest === '/labels' && method === 'POST') {
      if (st.labels.has(String(body?.name).toLowerCase())) return this.#validation(res, 'already_exists', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
      st.labels.set(String(body.name).toLowerCase(), { id: seq++, name: body.name, color: body.color ?? 'ededed', description: body.description ?? null });
      return this.#send(res, 201, this.#labelJson(st, body.name));
    }

    m = /^\/issues\/(\d+)\/(labels|comments)$/.exec(rest);
    if (m) {
      const n = Number(m[1]);
      const p = st.pulls.find((x) => x.number === n);
      if (!p) return this.#send(res, 404, { message: 'Not Found' });
      if (m[2] === 'labels' && method === 'POST') {
        for (const l of body?.labels ?? []) {
          if (!st.labels.has(l.toLowerCase())) st.labels.set(l.toLowerCase(), { id: seq++, name: l, color: 'ededed', description: null });
          if (!p.labels.includes(l)) p.labels.push(l);
        }
        return this.#send(res, 200, p.labels.map((l) => this.#labelJson(st, l)));
      }
      if (m[2] === 'comments' && method === 'GET') return this.#paged(req, res, url, st.comments.filter((c) => c.issue === n).map((c) => this.#commentJson(st, c)));
      if (m[2] === 'comments' && method === 'POST') {
        const c: Comment = { id: seq++, issue: n, body: body.body, created_at: now(), updated_at: now() };
        st.comments.push(c);
        return this.#send(res, 201, this.#commentJson(st, c));
      }
    }
    m = /^\/issues\/comments\/(\d+)$/.exec(rest);
    if (m && method === 'PATCH') {
      const c = st.comments.find((x) => x.id === Number(m![1]));
      if (!c) return this.#send(res, 404, { message: 'Not Found' });
      c.body = body.body;
      c.updated_at = now();
      return this.#send(res, 200, this.#commentJson(st, c));
    }

    m = /^\/commits\/([^/]+)\/check-runs$/.exec(rest);
    if (m && method === 'GET') {
      const name = url.searchParams.get('check_name');
      const runs = st.checks.filter((c) => c.head_sha === m![1] && (!name || c.name === name)).reverse();
      return this.#send(res, 200, { total_count: runs.length, check_runs: runs.map((c) => this.#checkJson(st, c)) });
    }
    if (rest === '/check-runs' && method === 'POST') {
      if (!isApp) return this.#send(res, 403, { message: 'You must authenticate via a GitHub App.', documentation_url: 'https://docs.github.com/rest/checks/runs#create-a-check-run' });
      if (!body?.name || !body?.head_sha) return this.#validation(res, 'name and head_sha are required');
      const c: CheckRun = { id: seq++, name: body.name, head_sha: body.head_sha, status: body.status ?? 'queued', conclusion: body.conclusion ?? null, details_url: body.details_url ?? null, output: body.output };
      st.checks.push(c);
      return this.#send(res, 201, this.#checkJson(st, c));
    }
    m = /^\/check-runs\/(\d+)$/.exec(rest);
    if (m && method === 'PATCH') {
      if (!isApp) return this.#send(res, 403, { message: 'You must authenticate via a GitHub App.' });
      const c = st.checks.find((x) => x.id === Number(m![1]));
      if (!c) return this.#send(res, 404, { message: 'Not Found' });
      Object.assign(c, { status: body.status ?? c.status, conclusion: body.conclusion ?? c.conclusion, details_url: body.details_url ?? c.details_url, output: body.output ?? c.output });
      return this.#send(res, 200, this.#checkJson(st, c));
    }

    return this.#send(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
  }

  #graphql(res: http.ServerResponse, body: any) {
    const q = String(body?.query ?? '');
    if (/markPullRequestReadyForReview/.test(q)) {
      const id = body?.variables?.id;
      for (const st of this.repos.values()) {
        const p = st.pulls.find((x) => x.node_id === id);
        if (p) {
          p.draft = false;
          p.updated_at = now();
          return this.#send(res, 200, { data: { markPullRequestReadyForReview: { pullRequest: { number: p.number, isDraft: false } } } });
        }
      }
      return this.#send(res, 200, { data: { markPullRequestReadyForReview: null }, errors: [{ type: 'NOT_FOUND', path: ['markPullRequestReadyForReview'], message: `Could not resolve to a node with the global id of '${id}'` }] });
    }
    return this.#send(res, 200, { errors: [{ message: 'Fake GitHub: unsupported GraphQL operation' }] });
  }
}
