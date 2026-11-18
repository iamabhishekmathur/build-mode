import { sign } from 'node:crypto';

/**
 * Returns a token for the `Authorization: Bearer` header. Called before every request, so a
 * provider can refresh short-lived tokens (GitHub App installation tokens live one hour).
 */
export type TokenProvider = () => Promise<string>;

/** Local dev: a personal access token or `gh auth token` output in GITHUB_TOKEN or GH_TOKEN. */
export function envTokenProvider(env: NodeJS.ProcessEnv = process.env): TokenProvider {
  return async () => {
    const t = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (!t) throw new Error('No GitHub token. Set GITHUB_TOKEN or GH_TOKEN (for example: export GITHUB_TOKEN=$(gh auth token)).');
    return t;
  };
}

export function staticTokenProvider(token: string): TokenProvider {
  return async () => token;
}

/**
 * The least-privilege permission set of the Stagecraft GitHub App (FR-1101).
 * Requested again on every installation-token exchange so a token never carries more,
 * even if the installation was granted more.
 */
export const APP_PERMISSIONS = {
  contents: 'write', // create proto/* branches (git refs), push commits
  pull_requests: 'write', // draft PRs, body updates, labels and comments on PRs, ready for review, reviewers
  checks: 'write', // the "Stagecraft" check run with the preview link and state-matrix screenshot
  metadata: 'read', // repo + default branch, branch list (always granted to Apps)
} as const;

export interface AppCredentials {
  /** GitHub App ID (or client ID, which GitHub also accepts as `iss`). */
  appId: string;
  /** PEM private key of the App. Never commit it; the cloud reads it from a secret store. */
  privateKey: string;
  installationId: number | string;
}

export interface AppTokenOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Narrow the token to these repos (names, without owner). */
  repositories?: string[];
  now?: () => number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 JWT that authenticates as the App itself (valid at most 10 minutes; we use 9, backdated 60 s for clock skew). */
export function appJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

/**
 * GitHub App installation tokens (the cloud product's auth). NOT USED YET: Stagecraft has no
 * registered App and no App credentials. It is here so the client does not change when the App
 * exists, and it is tested only against the fake GitHub server in tests/.
 *
 * Exchange (per GitHub docs "Authenticating as a GitHub App installation"):
 *   1. Sign a JWT with the App private key: { iss: appId, iat, exp <= iat + 10 min }, RS256.
 *   2. POST {baseUrl}/app/installations/{installation_id}/access_tokens
 *      Authorization: Bearer <JWT>, body { repositories?, permissions? }
 *      → 201 { token, expires_at, permissions, repository_selection }
 *   3. Use `token` as a Bearer token for REST and GraphQL. It expires after one hour; we refresh
 *      five minutes early.
 * Note: installation tokens act as the App, so `GET /user` does not work with them. The human's
 * login (for proto/<user>/<slug>) must come from the user-to-server OAuth token of the app UI.
 */
export function appInstallationTokenProvider(creds: AppCredentials, opts: AppTokenOptions = {}): TokenProvider {
  const baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt - 5 * 60_000 > now()) return cached.token;
    const res = await f(`${baseUrl}/app/installations/${creds.installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${appJwt(creds.appId, creds.privateKey, now())}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'stagecraft',
      },
      body: JSON.stringify({ permissions: APP_PERMISSIONS, ...(opts.repositories ? { repositories: opts.repositories } : {}) }),
    });
    const data = (await res.json().catch(() => null)) as { token?: string; expires_at?: string; message?: string } | null;
    if (!res.ok || !data?.token) throw new Error(`GitHub App token exchange failed (HTTP ${res.status}): ${data?.message ?? 'no token'}`);
    cached = { token: data.token, expiresAt: data.expires_at ? Date.parse(data.expires_at) : now() + 60 * 60_000 };
    return cached.token;
  };
}
