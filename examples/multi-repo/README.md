# Multi-repo example

Four folders that stand for four **separate git repos** of one product:

| Repo | Role | What it is |
|---|---|---|
| `acme-web` | host app | Customer dashboard (React + Vite). Holds `stagecraft.config.ts`, scenarios and tapes. |
| `acme-ui` | library | Design system package `@acme/ui`. Linked into both apps for dev. |
| `acme-admin` | app | Internal admin app (React + Vite, base path `/admin`). Served through the same proxy. |
| `acme-api` | api | Backend repo. Only its `openapi.json` matters here: the contract the mocks are checked against. |

```bash
cd acme-web
node ../../../packages/cli/src/bin.ts workspace status
node ../../../packages/cli/src/bin.ts dev        # links @acme/ui, starts both apps, one proxy
# http://127.0.0.1:4420        dashboard
# http://127.0.0.1:4420/admin/ admin app: same mock DB, same session
```

In this monorepo the folders are not git repos; the tests copy them to a temp folder and `git init` each one.
