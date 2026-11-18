# GitHub integration

Every prototype is a git branch and a GitHub draft PR. This is the PRD's GitHub section (FR-1101 to FR-1109), v1 for GitHub.com only. The code is in `packages/github` (`@stagecraft/github`). The CLI commands are `stagecraft pr …` and `stagecraft branch-from …`, and the MCP tools are `github_*`.

**Status:** built and tested against a fake GitHub server (`tests/fake-github.ts`) and local bare git remotes. **It has not been run against the real GitHub API.** No GitHub App is registered yet, so local use needs a personal token.

## How it works

```
designer + agent ──▶ stagecraft pr open ──▶ git commit (human author, agent co-author)
                                         ──▶ git push -u origin proto/<user>/<slug>
                                         ──▶ GitHub REST: find PR by head → create draft PR / update it
                                                          → ensure label stagecraft-prototype
                     stagecraft pr comment ──▶ upsert the one <!-- stagecraft:preview --> comment
                                           ──▶ create/update the "Stagecraft" check run on the head SHA
                     stagecraft pr ready   ──▶ run the handoff gate → GraphQL markPullRequestReadyForReview
                                                (or refuse; or record the override reason, then mark ready)
```

| FR | What happens | Test (`tests/integration/github.test.ts`) |
|---|---|---|
| 1102 branch + draft PR | `pr open` on the base branch creates `proto/<user>/<slug>` (slug from `--slug` or the title, sanitized to `a-z0-9-`). It commits any uncommitted change, pushes, and creates a **draft** PR with the label `stagecraft-prototype` (the label is created if missing). Running it again updates the same PR (title, body, label) and never opens a second one. | "pr open: new proto branch…", "pr open again updates…" |
| 1103 branch from | `branch-from list` shows prototype branches (`proto/*`, with their open PR) and every other branch the token can read. `branch-from <branch>` creates `proto/<user>/<slug>` on GitHub at that branch's head, checks it out, and records the source as the PR base (git config `branch.<name>.stagecraftBase`). So a prototype started from an engineer's branch opens its PR against that branch. | "branch-from lists sources…" |
| 1104 preview comment + check | `pr comment --preview-url U --screenshot S` edits **one** comment, found by the hidden marker `<!-- stagecraft:preview -->`, and creates or updates one `Stagecraft` check run per head commit (`details_url` = preview, `output.images` = the state-matrix screenshot). The screenshot is an https URL, or a file committed and pushed in the repo, linked as `…/blob/<sha>/<path>?raw=true`. | "pr comment upserts…", "…committed screenshot file" |
| 1105 ready for engineering | `pr ready` runs the gate (`--gate "<cmd>"`, default `npx --no stagecraft check handoff`). Exit 0: the PR leaves draft. Non-zero with no `--override`: refused (exit 1), the gate output is printed, and nothing changes on GitHub. With `--override "<reason>"`: the reason, user, date, gate command and the tail of its output are appended to a "Handoff override" section in the PR body, then the PR leaves draft. | "pr ready refuses…", "pr ready --override…" |
| 1108 never merge | The client has no merge method and no command or tool merges. A test scans every file under `packages/` for the merge endpoint, `mergePullRequest` and `merge_method`, and fails if it finds any. Pushes go only to the prototype branch, never with `--force`, and pushing the repo's default branch or the PR base is refused. | "FR-1108…" |
| 1109 authorship | Commits use the human's `git config user.name/email` as author and committer, plus the trailer `Co-authored-by: Claude <noreply@anthropic.com>`. Change the co-author with `--co-author "<Name> <email>"` or `STAGECRAFT_CO_AUTHOR`. | "pr open: new proto branch…" |
| multi-repo | `pr open --workspace` (in the host repo) uses one branch name across repos. It opens one draft PR per changed writable repo: uncommitted changes, commits on the prototype branch, or a PR from an earlier run. The order is libraries, then other repos, then apps, with the host last. Each PR body gets a "Related PRs" section with the merge order, rewritten on every run. Read-only repos (`api`) are skipped. | "multi-repo…" |

The owner and name of each repo come from its `origin` remote: `https://host/owner/repo(.git)`, `git@host:owner/repo.git` and `ssh://git@host[:port]/owner/repo.git` are all read. Stagecraft reads the configured URL, not the `insteadOf`-rewritten one.

The user in `proto/<user>/<slug>` comes from `--user`, then `STAGECRAFT_USER`, then `GET /user` (works with a personal token only), then `git config user.name`.

Stagecraft owns parts of the PR body, which sit between hidden markers (`<!-- stagecraft:related:start -->` … `end`, and the same for `override`). Run `pr open --body-file` to replace the rest of the description; these parts are kept.

## Commands

```
npx --no stagecraft pr open [--title T] [--body-file F] [--slug S] [--message M] [--base B] [--workspace] [--json]
npx --no stagecraft pr status [--json]
npx --no stagecraft pr comment [--body-file F] [--preview-url U] [--screenshot URL|file] [--conclusion success|neutral|failure]
npx --no stagecraft pr ready [--gate "<cmd>"] [--override "<reason>"] [--reviewer login[,login]]
npx --no stagecraft branch-from list | <branch> [--slug S]
```

Environment: `GITHUB_TOKEN` or `GH_TOKEN` (for example `export GITHUB_TOKEN=$(gh auth token)`), and `STAGECRAFT_GITHUB_API_URL` (default `https://api.github.com`; tests point it at the fake server).

MCP: `registerGithubTools(tool, deps)` from `@stagecraft/github` adds `github_pr_open`, `github_pr_status`, `github_pr_comment`, `github_pr_ready`, `github_branch_list` and `github_branch_from` to the Stagecraft MCP server. `tool` is the `tool(name, description, zodShape, handler)` helper in `packages/mcp/src/server.ts`.

## The GitHub App this needs (FR-1101)

Install it on selected repos only. It needs these permissions and no others:

| Permission | Access | Why |
|---|---|---|
| Contents | write | Push `proto/*` branches; create a branch from a ref (`POST /git/refs`) for "branch from". |
| Pull requests | write | Create draft PRs, edit title and body, mark ready for review (GraphQL), request reviewers. It also covers labels and comments on PRs: these use the `issues/{n}/…` endpoints, which accept Pull requests permission for PRs. |
| Checks | write | The `Stagecraft` check run. GitHub allows check runs only for Apps: with a personal token, `pr comment` skips the check, warns, and still updates the comment. |
| Metadata | read | Repo, default branch, branch list (always granted). |

The App needs no Administration permission, no Workflows permission and no Merge queue access, and the API it uses cannot merge. Branch protection rules apply to the merging engineer, not to Stagecraft. Stagecraft only pushes `proto/*` branches.

`appInstallationTokenProvider()` in `packages/github/src/auth.ts` implements the App flow: an RS256 JWT `{iss: appId, iat, exp ≤ 10 min}`, then `POST /app/installations/{id}/access_tokens` with the permission set above, cached until 5 minutes before `expires_at`. It is tested only against the fake server, with a key pair generated in the test. No App exists and no credentials are anywhere in the repo. Installation tokens cannot call `GET /user`. The cloud product must take the human's login from the user-to-server OAuth token.

## What is stubbed or unverified

- **Not run against api.github.com.** Request and response shapes follow the REST docs (API version `2022-11-28`). The fake returns those shapes. These are the points I am least sure of:
  - Whether creating a repo label (`POST /repos/{o}/{r}/labels`) is allowed with **Pull requests: write** alone, or also needs **Issues: write**. Adding a label to a PR and commenting on a PR accept Pull requests permission, as far as I know. If label creation is refused, the fix is to create the label once at install time, or to add Issues: write.
  - Whether a `neutral` check conclusion counts as passing for a required status check. We default to `success`.
  - `GET /repos/{o}/{r}/pulls?head=owner:branch` finds PRs from branches in the same repo only. Fork-based prototypes are not supported.
  - Draft PRs need a plan that supports them on private repos. On repos without drafts, GitHub returns 422 and `pr open` reports the error. There is no fallback.
- **Preview link and screenshot hosting.** `pr comment` takes the URL; there is no cloud preview yet. The state-matrix image must be an https URL or a committed file. GitHub has no API to upload comment attachments.
- **Gate default.** `npx --no stagecraft check handoff` is the PRD's handoff check (FR-10xx). That command does not exist in this slice yet, so pass `--gate` (for example `--gate "npx --no stagecraft doctor && npm test"`) until it does.
- **No webhooks.** The comment and check update when `pr comment` runs (the `handoff` skill runs it after each push), not on GitHub push events. The App's webhook receiver is cloud work.
- **Reviewers** are requested only on `pr ready --reviewer`. CODEOWNERS still applies on GitHub's side.
- **GitHub Enterprise Server** is out of scope for v1. A custom base URL works for REST; GraphQL would need `/api/graphql`.
