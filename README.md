# Stagecraft (working name): local core

Prototype in the **real product** on **mock data**, in any product state, with the coding agent you already use.

This repo builds slices of the PRD *"Builder Mode for Everyone"*:
1. the **local core**, plus the **stateful mock DB** and **tapes**;
2. **server-side mocking** for SSR / React Server Components, proven on Next.js 16 App Router;
3. **multi-repo products**: several apps, a design-system repo and an API repo behind one proxy ([docs/multi-repo.md](docs/multi-repo.md));
4. an **eval harness v0** that runs Claude Code headless on prototyping tasks and checks the result ([evals/](evals/)).

It does not include the desktop app, the cloud runtime, GitHub/Figma integrations, feedback, checks, billing or admin. See [What is not built](#what-is-not-built).

> **Name warning (OQ-1):** the npm name `stagecraft` belongs to an unrelated package. Every generated command uses `npx --no stagecraft`, which fails instead of downloading it. Pick a product name with a free npm name before publishing.

## Try it (2 minutes)

Needs Node ≥ 22.18. Node runs the TypeScript sources directly, so there is no build step except for the browser bundle.

```bash
npm install
npm run demo          # builds the panel, starts Vite + the Stagecraft proxy
# open http://127.0.0.1:4400
```

In the panel (bottom right; ⇤ docks it left; Alt+Shift+S hides it):

1. **Persona** → *Employee (Eli)*. **Account** → *Frozen*. The app re-renders from the mock DB. There is no page reload.
2. Open **Onboarding** as Eli and complete a step. Switch to Admin, then back. Eli's progress is kept (FR-503).
3. Open **Agent controls**. **Variants** → `agent-list-layout` → *cards*. Press ⇆ to see both options side by side.
4. **Scenarios** → *Bill pay company – frozen*. Type a name and press **Save**: this writes `stagecraft/scenarios/<name>.json`.
5. **Tape** → *$4,200 vendor payment…*. Dock the panel left (⇤) and open **Assistant**. The chat streams, times out once, and you press **Retry**. Then **Approve** or **Reject** in the real UI, and the tape follows that branch.
6. Deep link: `http://127.0.0.1:4400/?__sc_session=fork&sc_tape=vendor-payment-approval&sc_step=9`

The address bar always reproduces the current view (`__sc=` param). Agents use the same features through MCP (`npx stagecraft mcp`).

## Tests

```bash
npm test              # 74 tests: unit, HTTP integration, CLI, MCP (stdio), production bundle, Playwright E2E
npm run typecheck
```

E2E runs real Vite, the real proxy and headless Chromium against the demo app. CI is in `.github/workflows/ci.yml`.

## Layout

| Package | What it is |
|---|---|
| `packages/core` | Isomorphic types and pure logic: DB path patches, tape format + validator, scenario `extends`, share-link encoding, `defineConfig`. JSON schemas in `schema/`. |
| `packages/server` | Dev proxy: HTML injection, CSP strip (dev only), mock routing, faults, sessions, mock DB, fork-on-open, scenarios, tape player (SSE + WebSocket), control API, stack detection. |
| `packages/runtime` | Browser runtime + panel (Web Component in Shadow DOM, 18 kB). Injected by the proxy. Product code never imports it. |
| `packages/react` | React adapter: `<StagecraftRoot>`, `<Variant>`, `useVariant`, `useFlag`, `useMockDbVersion`. No-ops in production. |
| `packages/mcp` | `stagecraft-mcp` (stdio): 24 tools for states, personas, flags, variants, scenarios, mock DB, faults, tapes, preview URL/navigate/screenshot. |
| `packages/cli` | `stagecraft init / detect / dev / doctor / agents sync / agents check / scenario list / tape validate / mcp`. Templates for agent instructions and 8 skills. |
| `packages/evals` | Eval harness v0: copies a fixture repo, runs `claude -p` with the repo's generated settings, restarts the app and checks the result. |
| `examples/ref-react-vite` | Reference app "Ledgerly" (React 19, Vite, React Router) wired for Stagecraft. Generated `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, skills and MCP configs are checked in. |
| `examples/ref-next-app` | Next.js 16 App Router app; server components fetch a cross-origin API. |
| `examples/multi-repo` | Four repos of one product: `acme-web` (host), `acme-ui` (design system), `acme-admin` (second app at `/admin`), `acme-api` (OpenAPI contract). |

### How it works

```
browser ──▶ Stagecraft proxy :4400 ──▶ your dev server (any framework)
   │            │  injects boot data + runtime.js into HTML
   │            │  /api/* and declared API origins → mock handlers + mock DB (never the real backend)
   │            │  /__stagecraft/api/* → control API (panel, MCP)
   │            └─ tape endpoint → tape player (SSE or WebSocket)
   └─ runtime.js: routes fetch/XHR/EventSource/WebSocket for cross-origin API hosts to the proxy,
                  keeps the URL linkable, mounts the panel, tells adapters to re-render
agent ──MCP──▶ stagecraft-mcp ──HTTP──▶ control API (same sessions the browser sees)
```

The mock DB lives in the proxy (Node), not in the browser. So the app, the panel and the agent all see one state, and share links can fork it.

**Server rendering.** `stagecraft dev` starts the dev server with `node --import @stagecraft/server/preload`. The preload keeps the incoming request's session in `AsyncLocalStorage` and sends server-side `fetch` calls to API origins through the proxy with that session. So server components, SSR loaders and the browser all read one mock DB, per session. Proven on Next.js 16 App Router (RSC, client navigation, forks). Other Node SSR frameworks (Nuxt, SvelteKit, Remix, Angular SSR) use the same mechanism but are not tested yet. Not covered: edge runtimes, and server code that calls APIs with `http.request` (axios on Node) instead of `fetch`.

### Wiring a repo

`npx stagecraft init` writes `stagecraft.config.ts`, `stagecraft/{seed,mocks,states}.ts`, `.env.stagecraft`, agent files and MCP configs. Everything is under `stagecraft/`, agent folders, or dev-only config (FR-106). Product code needs only:

```tsx
<BrowserRouter><StagecraftRoot><App/></StagecraftRoot></BrowserRouter>   // optional; without it, state changes reload the page
<Variant name="agent-list-layout" options={{ table: <Table/>, cards: <Cards/> }} />
const sidebar = useFlag('new-nav', false);
```

If you use React Query, Apollo or SWR, put their provider **inside** `<StagecraftRoot>` so a state change also clears their cache.

## PRD traceability (this slice)

✅ done and tested · ◐ partial · ✗ not built. "Test" names the file that proves it.

| FR | Status | Notes / test |
|---|---|---|
| 101 detect stack | ✅ | Framework + tier, bundler, package manager, monorepo, dev cmd/port, Node, router, API style + specs, state libs, flag vendor, design system, Storybook (+ MCP addon). `cli.test.ts`. The ≥95% AC needs the full reference suite, which does not exist yet. |
| 102 monorepo | ◐ | Lists apps; no app picker. |
| 104 auto-fix setup | ◐ | CSP stripped; env denylist + `.env.stagecraft`. No setup agent; the `setup` skill guides the user's agent. |
| 105 / 108 report, doctor | ✅ | `stagecraft doctor`: config, state patches, stale scenarios, unmocked endpoints (static + runtime), mock leakage, agent-file drift. |
| 106 setup files | ◐ | `init` writes only allowed paths. No PR (no GitHub App yet). |
| 207 own IDE/terminal | ✅ | Plain checkout; `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`. |
| 302 MCP server | ✅ stdio | `mcp.test.ts`. No Streamable HTTP yet. **Tool names differ from the PRD** (see below). |
| 303 instructions from one source | ✅ | `stagecraft/agents.md` → `AGENTS.md` (managed block keeps user text), `CLAUDE.md` (`@AGENTS.md`), `.cursor/rules/*.mdc`. `agents check` fails CI on drift. |
| 304 skills | ◐ | 8 of 9 skills, in `.claude/skills`, `.agents/skills`, `.cursor/skills`. `handle-feedback` is missing because feedback is not built. |
| 401 state catalog | ✅ | `stagecraft/states.ts`, typed. DB patch + forced flags per state. |
| 402 personas | ✅ | Persona switches keep the DB. |
| 403 flags | ◐ | In-house flags with per-session overrides. **No vendor adapters yet** (OpenFeature, LaunchDarkly are MVP P0 in the PRD). |
| 404 variants | ✅ | `<Variant>` / `useVariant`; switch with no rebuild or reload. E2E. |
| 405 side by side | ✅ | `/__stagecraft/compare`: 2–4 forked frames, scroll + nav sync. E2E. |
| 409 faults | ✅ | Latency, status, no response per endpoint; app refetches. E2E. |
| 501 intercept | ✅ / ◐ | Browser: proxy + runtime patching (not a Service Worker; see below). Server: Node preload for `fetch` (Next.js 16 RSC E2E). Not covered: edge runtime, `http.request` clients. |
| 503 / 504 / 505 mock DB | ✅ | Stateful per session; `shared` mode; fork-on-open. FR-503 AC passes in E2E. MCP `mockdb_*`. |
| 507 mock isolation | ✅ | Production `vite build` contains zero mock strings. `bundle.test.ts`. |
| 601 / 602 / 604 scenarios | ✅ | JSON files with DB snapshot, `extends`, schema. Pixel-diff AC not measured; state + DB reproduce exactly. |
| 603 / 605 library, health | ◐ | Shared through git. `doctor` marks stale scenarios. |
| 701–707, 709 tapes | ✅ | Validator + schema; SSE and WebSocket; deep link = playback (unit-tested for event history + DB); interactive branches; timeout/retry, partial stream, error; keyboard timeline. E2E for J-7. |
| 801, 805, 806 panel | ✅ | Shadow DOM; hidden mode adds zero pixels (pixel-equal E2E); URL reproduces the view in a new browser. |
| 802 panel controls | ◐ | Persona, states, flags, variants, scenarios, tapes, faults, mock DB. No versions, viewport, theme or locale controls. |
| 803 browsers | ◐ | Tested in Chromium only. |

## Where I deviated from the PRD, and why

1. **MCP tool names use `_`, not `.`** (`state_set`, not `state.set`). The Anthropic and OpenAI APIs accept only `[a-zA-Z0-9_-]` in tool names. Dotted names can fail in the agents we target. A test enforces the rule.
2. **No Service Worker.** The runtime patches `fetch`, `XMLHttpRequest`, `EventSource` and `WebSocket` before app code runs, and same-origin API paths are served by the proxy. A Service Worker is not active on the first page load and needs scope and registration handling. Cost of this choice: requests from Web Workers and cross-origin iframes are not routed. Revisit if a design partner needs that.
3. **The mock DB lives in the proxy**, so the app, the panel and MCP share one state, and links can fork it.
4. **Deep-link params are `sc_tape` / `sc_step`**, not `tape` / `step`, so they cannot collide with app params.
5. **A tape always starts from a known DB** (its scenario, or seed + selected states). Without this, a deep link opened in a session where the tape already ran gave a different result. Loading a tape therefore discards that session's ad-hoc DB writes.
6. **Added: panel dock toggle.** The E2E run showed that the bottom-right panel covers right-side drawers, such as the demo's chat. Expect this in many SaaS apps.

## What is not built

Desktop app, cloud runtime and sandboxes, GitHub App and draft PRs, Figma and Storybook integrations (only detection, plus the `apply-figma-frame` skill), feedback pins (FR-9xx), checks (FR-10xx; only `preview_screenshot` exists, for the `self-check` skill), element picker, versions, matrix view, mock generation from OpenAPI/GraphQL (FR-502), state discovery (FR-109), component guide (FR-305), hooks, sharing scopes, admin, billing, eval harness.

## Known risks in this slice

- **Not tested with real agents.** MCP is tested with the official SDK client over stdio. Claude Code, Codex and Cursor have not run the skills end to end here: this environment has no agent credentials. Do that next.
- **SSR beyond Next.js** (Nuxt, SvelteKit, Angular SSR) uses the same preload but is not tested. Next.js `fetch` caching (`force-cache`, `revalidate`) sits above our interceptor: cached server data can survive a state change.
- **No auth on the control API.** The proxy binds to `127.0.0.1` by default. `--host 0.0.0.0` exposes state control and mock-DB writes to your network.
