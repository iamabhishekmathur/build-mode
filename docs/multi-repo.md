# Products that span several repos

Many product teams do not have one frontend repo. Typical shapes:

| Shape | Example | What a prototype needs |
|---|---|---|
| App + design-system repo | `web` uses `@acme/ui` from npm | Change a component in `ui`, see it in `web` at once |
| Several frontends | dashboard + admin + marketing, one domain | A flow that crosses apps, with the same user and data |
| App + backend repo | `web` calls the API owned by `api` | Mocks that match the real API contract |
| Shared client/types repo | `@acme/api-client` | Same as a library |

## How Stagecraft handles it

**One host repo.** It holds `stagecraft.config.ts`, the mocks, scenarios and tapes. Its `workspace` section names the other repos and their roles:

```ts
workspace: {
  repos: {
    ui:    { path: '../acme-ui',    role: 'library', package: '@acme/ui', git: 'https://github.com/acme/ui.git' },
    admin: { path: '../acme-admin', role: 'app', devCommand: 'npm run dev', devUrl: 'http://localhost:5192', mount: '/admin' },
    api:   { path: '../acme-api',   role: 'api', openapi: 'openapi.json' },
  },
},
```

**One proxy, one mock DB, one session for every app.** `app` repos are mounted on a path prefix (`/admin`), or on their own proxy port (`port: 4401`) if they cannot use a base path. The mock DB lives in the proxy, so a state set in the dashboard is what the admin app sees. A viewer can walk a flow across apps. Forked sessions (share links, compare frames) carry over full page navigations through the `Referer`.

**Libraries are linked for dev only.** `stagecraft dev` (or `stagecraft workspace link`) puts a symlink to the library repo in each app's `node_modules`, like `npm link`. The installed copy is kept in `node_modules/.stagecraft-backup` and `workspace unlink` restores it. No `package.json` or lockfile changes. Vite serves the linked files with no `fs.allow` change (checked with repos outside any shared root).

**The API repo is read-only.** Its OpenAPI spec is the contract. `stagecraft doctor` reports both directions:
- spec operations with no mock (the prototype will hit a 404);
- mocks for endpoints the spec does not have (the prototype relies on an API that does not exist: that is backend work to list at handoff).

**Git: one branch name, one PR per changed repo.** `stagecraft workspace branch <name>` puts every writable repo on `proto/<name>`. `stagecraft workspace status` lists changed repos; that list is the PR set. Library PRs merge first; app PRs depend on them.

**Agents see every repo.**
- Claude Code: `.claude/settings.json` gets `permissions.additionalDirectories` for the other repos, plus Stagecraft tool permissions.
- Cursor / VS Code: `stagecraft.code-workspace` opens all repos as one multi-root workspace.
- All agents: `AGENTS.md` gets a "Workspace repos" table with each repo's role and rules (edit libraries at the source, never in `node_modules`; never edit the API repo).
- MCP: `workspace_status` returns repos, branches, changed files and links.

## Commands

```
stagecraft workspace status [--json]   repos, roles, branches, changed files, links
stagecraft workspace clone             clone missing repos from their git URL
stagecraft workspace link | unlink     dev-link library packages into every app
stagecraft workspace branch <name>     same prototype branch in every writable repo
stagecraft doctor                      + missing repos, unlinked libs, duplicate React, mixed branches,
                                         changes in read-only repos, mocks vs OpenAPI
```

## Known limits

- **Two copies of React.** If a library repo has its own `node_modules/react`, the linked app can load two Reacts and hooks break. Doctor warns. Fix: dedupe in the bundler (Vite `resolve.dedupe`), or remove React from the library's `node_modules`.
- **Libraries that ship only a build** (`main: dist/index.js`) need their watch build running. Stagecraft does not start it yet.
- **Module federation / runtime micro-frontends** that fetch remote bundles from other origins are not routed (Tier 3 in the PRD).
- **Codex** needs the other repos as writable roots. I have not verified the Codex flag for that; Claude Code and Cursor paths are generated.
- **No GitHub App yet**, so the linked PR set is a list, not real PRs.
