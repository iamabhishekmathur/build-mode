import { envTokenProvider, type TokenProvider } from './auth.ts';

/**
 * A small GitHub REST (+ one GraphQL mutation) client on `fetch`.
 *
 * Stagecraft never merges (FR-1108): this client has no method that merges a pull request, and a
 * static test fails the build if any package source mentions the merge endpoint.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  owner: { login: string };
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface GhBranch {
  name: string;
  commit: { sha: string; url?: string };
  protected: boolean;
}

export interface GhLabel {
  id: number;
  name: string;
  color: string;
  description?: string | null;
}

export interface GhPull {
  id: number;
  node_id: string;
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  labels: GhLabel[];
  requested_reviewers?: { login: string }[];
}

export interface GhComment {
  id: number;
  body: string;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

export interface GhCheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  details_url: string | null;
  html_url: string | null;
  output: { title: string | null; summary: string | null };
}

export type CheckConclusion = 'success' | 'neutral' | 'failure' | 'action_required';

export interface CheckRunInput {
  headSha: string;
  title: string;
  summary: string;
  text?: string;
  detailsUrl?: string;
  conclusion?: CheckConclusion;
  /** Shown in the check's output (GitHub renders `image_url` as an image). */
  images?: { alt: string; image_url: string; caption?: string }[];
}

export class GitHubError extends Error {
  status: number;
  data: any;
  constructor(status: number, message: string, data: any) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.data = data;
  }
}

export interface ClientOptions {
  /** Default https://api.github.com. Env STAGECRAFT_GITHUB_API_URL overrides it in createClient(). */
  baseUrl?: string;
  token?: TokenProvider;
  fetch?: typeof fetch;
  /** Page size for list calls (GitHub max is 100). */
  perPage?: number;
}

export const PROTOTYPE_LABEL = { name: 'stagecraft-prototype', color: '7c3aed', description: 'Prototype made with Stagecraft' };
export const PREVIEW_MARKER = '<!-- stagecraft:preview -->';
export const CHECK_NAME = 'Stagecraft';

const enc = encodeURIComponent;
/** Branch names keep their slashes in REST paths (GitHub expects `proto/a/b`, not `proto%2Fa%2Fb`). */
const encRef = (ref: string) => ref.split('/').map(enc).join('/');

export class GitHubClient {
  baseUrl: string;
  graphqlUrl: string;
  token: TokenProvider;
  perPage: number;
  #fetch: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    // GitHub.com serves GraphQL at api.github.com/graphql (v1 is GitHub.com only; GHES uses /api/graphql).
    this.graphqlUrl = `${this.baseUrl}/graphql`;
    this.token = opts.token ?? envTokenProvider();
    this.perPage = opts.perPage ?? 100;
    this.#fetch = opts.fetch ?? fetch;
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#raw(method, path.startsWith('http') ? path : `${this.baseUrl}${path}`, body);
    return (await this.#json(res)) as T;
  }

  async #raw(method: string, url: string, body?: unknown): Promise<Response> {
    return this.#fetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${await this.token()}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'stagecraft',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async #json(res: Response) {
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!res.ok) {
      const errs = Array.isArray(data?.errors) ? data.errors.map((e: any) => e.message ?? e.code).filter(Boolean).join('; ') : '';
      throw new GitHubError(res.status, `GitHub ${res.status}: ${data?.message ?? res.statusText}${errs ? ` (${errs})` : ''}`, data);
    }
    return data;
  }

  /** GET every page of a list endpoint, following the `Link: <…>; rel="next"` header. */
  async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${this.baseUrl}${path}${path.includes('?') ? '&' : '?'}per_page=${this.perPage}`;
    while (url) {
      const res = await this.#raw('GET', url);
      const page = (await this.#json(res)) as T[];
      out.push(...page);
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    }
    return out;
  }

  // ---------- repo, user, branches ----------

  getRepo(r: RepoRef) {
    return this.request<GhRepo>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}`);
  }

  /** Login of the token's user. Works for PATs and user-to-server tokens, not App installation tokens. */
  getViewer() {
    return this.request<{ login: string; name: string | null }>('GET', '/user');
  }

  listBranches(r: RepoRef) {
    return this.paginate<GhBranch>(`/repos/${enc(r.owner)}/${enc(r.repo)}/branches`);
  }

  getBranch(r: RepoRef, branch: string) {
    return this.request<GhBranch>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/branches/${encRef(branch)}`);
  }

  /** Create `refs/heads/<branch>` at the commit `fromRef` (a branch name or a commit SHA) points to. */
  async createBranch(r: RepoRef, branch: string, fromRef: string) {
    const sha = /^[0-9a-f]{40}$/.test(fromRef) ? fromRef : (await this.getBranch(r, fromRef)).commit.sha;
    return this.request<{ ref: string; object: { sha: string } }>('POST', `/repos/${enc(r.owner)}/${enc(r.repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  // ---------- pull requests ----------

  /** The open PR whose head is `<owner>:<branch>`, or null. */
  async findPullByHead(r: RepoRef, branch: string, state: 'open' | 'all' = 'open'): Promise<GhPull | null> {
    const list = await this.request<GhPull[]>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls?head=${enc(`${r.owner}:${branch}`)}&state=${state}&per_page=10`);
    return list[0] ?? null;
  }

  getPull(r: RepoRef, number: number) {
    return this.request<GhPull>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${number}`);
  }

  listOpenPulls(r: RepoRef) {
    return this.paginate<GhPull>(`/repos/${enc(r.owner)}/${enc(r.repo)}/pulls?state=open`);
  }

  createDraftPull(r: RepoRef, p: { title: string; head: string; base: string; body: string }) {
    return this.request<GhPull>('POST', `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls`, { ...p, draft: true });
  }

  /** Title and body only. REST cannot change `draft`; see markReadyForReview(). */
  updatePull(r: RepoRef, number: number, p: { title?: string; body?: string }) {
    return this.request<GhPull>('PATCH', `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${number}`, p);
  }

  /**
   * Draft → ready for review. The REST "update a pull request" endpoint has no way to change
   * `draft`, so this uses the GraphQL mutation `markPullRequestReadyForReview` with the PR's node_id.
   */
  async markReadyForReview(pull: Pick<GhPull, 'node_id'>): Promise<{ number: number; isDraft: boolean }> {
    const res = await this.#raw('POST', this.graphqlUrl, {
      query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }',
      variables: { id: pull.node_id },
    });
    const data = await this.#json(res);
    if (data?.errors?.length) throw new GitHubError(200, `GitHub GraphQL: ${data.errors.map((e: any) => e.message).join('; ')}`, data);
    return data.data.markPullRequestReadyForReview.pullRequest;
  }

  requestReviewers(r: RepoRef, number: number, reviewers: string[], teamReviewers: string[] = []) {
    return this.request<GhPull>('POST', `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${number}/requested_reviewers`, { reviewers, team_reviewers: teamReviewers });
  }

  // ---------- labels (PRs are issues for labels and comments) ----------

  async ensureLabel(r: RepoRef, label = PROTOTYPE_LABEL): Promise<GhLabel> {
    try {
      return await this.request<GhLabel>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/labels/${enc(label.name)}`);
    } catch (e) {
      if ((e as GitHubError).status !== 404) throw e;
    }
    try {
      return await this.request<GhLabel>('POST', `/repos/${enc(r.owner)}/${enc(r.repo)}/labels`, label);
    } catch (e) {
      // Created concurrently (422 already_exists): read it again.
      if ((e as GitHubError).status !== 422) throw e;
      return this.request<GhLabel>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/labels/${enc(label.name)}`);
    }
  }

  async addLabel(r: RepoRef, number: number, label = PROTOTYPE_LABEL) {
    await this.ensureLabel(r, label);
    return this.request<GhLabel[]>('POST', `/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${number}/labels`, { labels: [label.name] });
  }

  // ---------- comments ----------

  listComments(r: RepoRef, number: number) {
    return this.paginate<GhComment>(`/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${number}/comments`);
  }

  /**
   * Create or update the one comment that contains `marker` (a hidden HTML comment). Never posts a
   * second one: if several exist (e.g. a race), the oldest is updated.
   */
  async upsertComment(r: RepoRef, number: number, body: string, marker = PREVIEW_MARKER): Promise<{ comment: GhComment; created: boolean }> {
    const full = body.includes(marker) ? body : `${marker}\n${body}`;
    const existing = (await this.listComments(r, number)).find((c) => c.body?.includes(marker));
    if (existing) {
      const comment = await this.request<GhComment>('PATCH', `/repos/${enc(r.owner)}/${enc(r.repo)}/issues/comments/${existing.id}`, { body: full });
      return { comment, created: false };
    }
    const comment = await this.request<GhComment>('POST', `/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${number}/comments`, { body: full });
    return { comment, created: true };
  }

  // ---------- check runs ----------

  async findCheckRun(r: RepoRef, sha: string, name = CHECK_NAME): Promise<GhCheckRun | null> {
    const res = await this.request<{ total_count: number; check_runs: GhCheckRun[] }>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/commits/${enc(sha)}/check-runs?check_name=${enc(name)}`);
    return res.check_runs[0] ?? null;
  }

  /**
   * One "Stagecraft" check run per head commit: created on the first call for a SHA, updated after.
   * Creating check runs needs a GitHub App token; a personal access token gets 403.
   */
  async upsertCheckRun(r: RepoRef, c: CheckRunInput): Promise<{ check: GhCheckRun; created: boolean }> {
    const payload = {
      name: CHECK_NAME,
      head_sha: c.headSha,
      status: 'completed',
      conclusion: c.conclusion ?? 'success',
      completed_at: new Date().toISOString(),
      ...(c.detailsUrl ? { details_url: c.detailsUrl } : {}),
      output: { title: c.title, summary: c.summary, ...(c.text ? { text: c.text } : {}), ...(c.images?.length ? { images: c.images } : {}) },
    };
    const existing = await this.findCheckRun(r, c.headSha);
    if (existing) {
      const { head_sha: _sha, ...patch } = payload;
      const check = await this.request<GhCheckRun>('PATCH', `/repos/${enc(r.owner)}/${enc(r.repo)}/check-runs/${existing.id}`, patch);
      return { check, created: false };
    }
    const check = await this.request<GhCheckRun>('POST', `/repos/${enc(r.owner)}/${enc(r.repo)}/check-runs`, payload);
    return { check, created: true };
  }
}

/** Client for the CLI and MCP: base URL from STAGECRAFT_GITHUB_API_URL, token from GITHUB_TOKEN / GH_TOKEN. */
export function createClient(opts: ClientOptions = {}, env: NodeJS.ProcessEnv = process.env): GitHubClient {
  return new GitHubClient({ baseUrl: env.STAGECRAFT_GITHUB_API_URL, token: envTokenProvider(env), ...opts });
}
