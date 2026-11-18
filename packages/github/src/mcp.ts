import { z } from 'zod';
import { createClient, type GitHubClient } from './client.ts';
import { branchFrom, commentPreview, listBranchSources, openPr, openWorkspacePrs, prStatus, readyForEngineering, type GithubContext } from './prototype.ts';

/**
 * The `tool(name, description, zodShape, handler)` helper of packages/mcp/src/server.ts.
 * The handler's return value is sent as JSON text; a thrown error becomes an MCP tool error.
 */
export type ToolRegistrar = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
) => unknown;

export interface GithubToolDeps {
  /** Repo the agent works in (default process.cwd()). */
  cwd?: string;
  /** Default: createClient() (STAGECRAFT_GITHUB_API_URL, GITHUB_TOKEN / GH_TOKEN). Created lazily per call. */
  client?: GitHubClient | (() => GitHubClient);
  coAuthor?: string;
  user?: string;
}

/**
 * Register the GitHub tools on the Stagecraft MCP server. Tool names use `_` (see server.ts).
 * There is deliberately no merge tool (FR-1108).
 */
export function registerGithubTools(tool: ToolRegistrar, deps: GithubToolDeps = {}) {
  const ctx = (): GithubContext => {
    const c = deps.client;
    return { client: typeof c === 'function' ? c() : (c ?? createClient()), coAuthor: deps.coAuthor ?? process.env.STAGECRAFT_CO_AUTHOR, user: deps.user };
  };
  const cwd = () => deps.cwd ?? process.cwd();

  tool(
    'github_pr_open',
    'Save the prototype to GitHub: commit uncommitted changes (the human is the author, you are the co-author), push the proto/<user>/<slug> branch, and create the draft PR with the stagecraft-prototype label, or update it. Safe to run again. workspace=true opens one PR per changed repo of a multi-repo product, libraries first, cross-linked.',
    {
      title: z.string().optional(),
      body: z.string().optional().describe('PR description (Markdown). Replaces the previous description; Stagecraft sections are kept.'),
      slug: z.string().optional().describe('Prototype name for a new branch, when the repo is on its base branch'),
      message: z.string().optional().describe('Commit message. Default: the title'),
      workspace: z.boolean().optional(),
    },
    async (a) => {
      if (a.workspace) return openWorkspacePrs(ctx(), cwd(), a);
      const r = await openPr(ctx(), cwd(), a);
      return { repo: r.repo, branch: r.branch, base: r.base, number: r.pr.number, url: r.pr.html_url, draft: r.pr.draft, created: r.created, committed: r.committed };
    },
  );

  tool('github_pr_status', 'The draft PR of the current branch: number, URL, draft state, labels, preview comment and the Stagecraft check.', {}, async () => {
    const s = await prStatus(ctx(), cwd());
    return {
      repo: s.repo,
      branch: s.branch,
      dirty: s.dirty,
      unpushedCommits: s.localAhead,
      pr: s.pr && { number: s.pr.number, url: s.pr.html_url, draft: s.pr.draft, title: s.pr.title, base: s.pr.base.ref, labels: s.pr.labels.map((l) => l.name) },
      previewComment: s.previewComment?.html_url ?? null,
      check: s.check && { status: s.check.status, conclusion: s.check.conclusion, url: s.check.html_url },
    };
  });

  tool(
    'github_pr_comment',
    'Post or update (in place, never a second one) the preview comment on the PR, with the preview link and the state-matrix screenshot, and set the "Stagecraft" check on the head commit. Run it after every push.',
    {
      body: z.string().optional().describe('Markdown: what changed, states covered'),
      previewUrl: z.string().optional(),
      screenshot: z.string().optional().describe('https URL, or a screenshot file committed and pushed in the repo'),
    },
    (a) => commentPreview(ctx(), cwd(), a).then((r) => ({ number: r.pr.number, comment: r.comment.html_url, created: r.created, check: r.check?.conclusion ?? null, warning: r.checkWarning })),
  );

  tool(
    'github_pr_ready',
    'Mark the PR ready for engineering. Only when the user asks. Runs the handoff gate; if it fails, nothing changes unless the user gives an override reason, which is recorded in the PR. Never merges.',
    { override: z.string().optional().describe("The user's reason to override a failing gate, in their words"), gate: z.string().optional() },
    async (a) => {
      const r = await readyForEngineering(ctx(), cwd(), a);
      return { status: r.status, number: r.pr.number, url: r.pr.html_url, draft: r.pr.draft, overridden: r.overridden, gate: r.gate };
    },
  );

  tool('github_branch_list', 'Branches a new prototype can start from: prototype branches (proto/*, with their open PR) and every other readable branch.', {}, () => listBranchSources(ctx(), cwd()));

  tool(
    'github_branch_from',
    'Start a new prototype branch proto/<user>/<slug> from any branch (a prototype or an engineer branch) and check it out. Its PR will target that branch.',
    { branch: z.string(), slug: z.string().optional() },
    (a) => branchFrom(ctx(), cwd(), a.branch, { slug: a.slug }),
  );
}
