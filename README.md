# Stagecraft (working name)

Prototype in the **real product** on **mock data**, in any product state, with the coding agent you already use (PRD: *"Builder Mode for Everyone"*).

Designers and PMs get a panel on top of the running app: switch persona, product state, flags, variants, time and faults; save scenarios; play assistant "tapes"; pin comments that go to the agent. The agent gets the same controls through MCP, plus skills, checks and a handoff gate, so the code it writes is shippable.

> **Name warning (OQ-1):** the npm name `stagecraft` belongs to an unrelated package. Every generated command uses `npx --no stagecraft`, which fails instead of downloading it. Pick a product name with a free npm name before publishing.

## Try it

Needs Node ≥ 22.18. Node runs the TypeScript sources directly.

```bash
npm install
npm run demo          # builds the panel, starts the React demo + proxy → http://127.0.0.1:4400
npm test              # 192 tests: unit, integration, MCP, CLI, Playwright E2E (React, Next.js, Vue, Nuxt, multi-repo, flags)
```

Panel tour: switch **Persona** and **Account** state, then press **💬** and click any element to leave a comment. Next, open the **Assistant** with the vendor-payment tape loaded. Press ⇆ on a variant to see the options side by side. `npx --no stagecraft share` makes a link for someone else.

## What is in the box

| Package | What it does |
|---|---|
| `core` | Types and pure logic: DB path patches, tapes, scenarios, share links, PII scrubber, seeded fake-data generators. |
| `server` | Dev proxy: HTML injection, mocks, mock DB, sessions, forks, faults, clock, tapes (SSE and WebSocket), feedback, share links, remote-access lock, server-side `fetch` interceptor (SSR/RSC), multi-repo workspaces, stack detection. |
| `runtime` | Browser runtime + panel (Shadow DOM): states, flags, variants, scenarios, tapes, faults, mock DB, time, comments, element picker with source mapping. |
| `react`, `vue` | Adapters: `StagecraftRoot`, `Variant`, `useFlag`, `useVariant`, `useMockDbVersion`. No-ops in production. |
| `flags` | Vendor adapters: OpenFeature (web + server), LaunchDarkly (v3, v4), GrowthBook, Unleash. |
| `checks` | fast (types + lint), components (design-system hygiene), visual (state matrix + detectors), a11y (axe), Figma fidelity, token map, matrix view, handoff gate, PR description. |
| `github` | Prototype branches, draft PRs, preview comments + checks, branch-from, ready-for-review behind the gate, multi-repo PR sets. No merge. |
| `mcp` | `stagecraft-mcp`: 48 tools for the agent (states, scenarios, mocks, tapes, feedback, checks, GitHub, dev logs/restart…). |
| `cli` | `init`, `dev`, `doctor`, `report`, `guide`, `discover`, `mocks generate`, `check …`, `matrix`, `describe`, `share`, `pr …`, `workspace …`, `agents sync/check`, `hook …`. Templates for agent instructions and 9 skills. |
| `evals` | Eval harness: runs Claude Code headless on prototyping tasks and checks the result automatically. |

Reference apps in `examples/`:
- `ref-react-vite` (React 19 + Vite);
- `ref-next-app` (Next.js 16 RSC);
- `ref-vue-vite` (Vue 3 + Pinia);
- `ref-nuxt` (Nuxt 4 SSR);
- `ref-flags` (real flag SDKs);
- `multi-repo` (four repos of one product).

Docs: [multi-repo](docs/multi-repo.md), [flags](docs/flags.md), [GitHub](docs/github.md), [what is left and how to build it](docs/remaining.md), [evals](evals/README.md).

### How it works

```
browser ──▶ Stagecraft proxy ──▶ app dev server(s)  ← started with a Node preload: server-side fetch → mocks
   │          │ injects runtime + panel into HTML
   │          │ API origins → mock handlers + mock DB (per session; forks for links and compare frames)
   │          │ /__stagecraft/api → control API (panel, MCP, CLI)   ·   only loopback, or share-link viewers
   └─ runtime: reroutes cross-origin API calls, keeps the URL linkable, panel, picker, adapters
agent ──MCP──▶ stagecraft-mcp ──▶ control API (same sessions) · checks · GitHub · dev logs/restart
```

## PRD status

✅ built and tested · ◐ partial (see note) · ✗ not built ([how to build it](docs/remaining.md)). "Fake GitHub" means tested against a local fake of the GitHub API; nothing ran against real GitHub.

### Functional requirements

| Area | FR | Status | Notes |
|---|---|---|---|
| Onboarding | 101 detect | ✅ | React, Next, Vue, Nuxt, SvelteKit, Angular, Remix, Astro, CRA…; tiers, package manager, monorepo, dev cmd/port, Node, router, API style + specs, state libs, flags, design system, Storybook. |
| | 102 monorepo | ◐ | Apps listed; no picker. Multi-repo products ✅ ([docs](docs/multi-repo.md)). |
| | 103 setup agent | ◐ | The customer's agent + `setup` skill + `init`, `dev_logs`, `dev_restart`. Measured by T-SET-01/02/03. No hosted setup agent. |
| | 104 auto-fix | ◐ | CSP strip, env denylist, `.env.stagecraft`, auth/env guidance, restart. Node version switching not automated. |
| | 105 setup report | ✅ | `stagecraft report` → Markdown for the setup PR; MCP `setup_report`. No desktop app to show it in. |
| | 106 setup PR | ◐ | `init` writes only allowed paths; `pr open` (fake GitHub). Production build proven free of mock strings, not compared byte for byte. |
| | 107 setup cache | ✗ | Cloud. |
| | 108 doctor | ✅ | Plus workspace and OpenAPI drift checks. |
| | 109 state discovery | ✅ | `stagecraft discover`. Recall on reference apps 10/15 = 67% (target 70%). |
| Runtime | 201 desktop app | ✗ | Design in docs/remaining.md. |
| | 202 local runtime | ✅ | `stagecraft dev`. Sends nothing to any Stagecraft server (there is none). |
| | 203–205 cloud | ✗ | Design in docs/remaining.md. |
| | 206 logs | ✅ | `dev_logs`, secret values masked. |
| | 207 own IDE | ✅ | Plain checkout + generated configs. |
| Agents | 301 Claude Code / Codex / Cursor | ◐ | Configs generated for all three. Only Claude Code exercised (evals). |
| | 302 MCP server | ✅ | stdio. HTTP transport ✗. |
| | 303 one source for instructions | ✅ | CI fails on drift. |
| | 304 skills | ✅ | 9 skills incl. `handle-feedback`. |
| | 305 component guide | ✅ | All exports, props, stories, usage, do/don't. |
| | 306 hooks | ✅ | Verified with real Claude Code: the hard-coded-color warning reached the agent in the same turn. |
| | 307 headless | ◐ | Claude Code in the eval harness. |
| | 308 keys | ✅ | No keys stored by Stagecraft; hooks block committing secrets. |
| | 309 plugin | ✗ | |
| States | 401–405, 409 | ✅ | Catalog, personas, flags, variants, side-by-side, faults. Plus a per-scenario clock. |
| | 403 flag vendors | ✅ | OpenFeature, LaunchDarkly, GrowthBook, Unleash (endpoints verified in SDK source). Statsig, Split ✗. |
| | 406 versions | ✗ | |
| | 407 matrix | ✅ | Grid page; cells link live. 20-cell timing not measured. |
| | 408 variant cleanup | ✅ | Gate detects leftovers; agent removes (T-HO-01). |
| Mocks | 501 intercept | ✅ | Browser + server (Next RSC, Nuxt). Not: edge runtime, `http.request` clients. |
| | 502 generation | ◐ | OpenAPI 3.x + TS types. GraphQL and recorded traffic ✗. |
| | 503–507 | ✅ | Stateful DB, forks, MCP DB tools, edge presets (1,200 rows, RTL, unicode…), no mock code in production builds. |
| Scenarios | 601, 602, 604 | ✅ | Files with DB snapshot, `extends`, schema, PII scrubbed. |
| | 603 library, 605 health | ◐ | Shared via git; doctor marks stale ones. |
| | 606 fixtures | ✗ | |
| Tapes | 701–707, 709 | ✅ | Validator, SSE + WS, deep links = playback, branches, errors/timeouts, keyboard timeline. |
| | 708 recording | ✗ | Scrubber ready. |
| Panel | 801, 805, 806 | ✅ | Shadow DOM; hidden = zero pixels; linkable URL. |
| | 802 controls | ◐ | No version/viewport/theme/locale controls. |
| | 803 browsers | ◐ | Chromium only. |
| | 804 element picker | ✅ | React 18/19, Vue, Svelte source mapping (React 19 tested). |
| Feedback | 901–905 | ✅ | Pins, regions, full context, send to agent, before/after replies, only people resolve. |
| | 906 PR sync, 907 voice | ✗ | |
| Checks | 1001 visual | ✅ | Detectors + screenshots for the agent's own review. Own seeded set 8/8. |
| | 1002 Figma | ✅ | Pixel score + regions + images; the agent is the judge. |
| | 1003–1007 | ✅ | fast ≤ 20 s, a11y (axe), components, handoff, deterministic (10/10 identical). |
| GitHub | 1101 App | ◐ | Permission set + token flow written; no App registered. |
| | 1102–1109 | ✅ (fake GitHub) | Branches, draft PRs + label, branch-from, comment + check, gated ready with override, PR description, never merges (static test), co-author trailer. |
| Figma | 1201, 1202, 1205 | ◐ | Through the user's Figma MCP + skill; not run here (no Figma account). |
| | 1203, 1204 | ✅ | Token map; fidelity check. |
| | 1206 | ✗ | |
| Storybook | 1301 | ◐ | CSF parsing; MCP addon not used. |
| | 1302, 1304 | ✅ | |
| | 1303 | ✗ | |
| Sharing | 1401 | ◐ | Link scope with expiry + password + revoke. Org / named-people scopes need identity. |
| | 1402 roles | ◐ | Viewer role only. |
| | 1403–1405 | ✅ | From the local proxy (no cloud): private fork per viewer, explore + comment only, admin switch. |
| | 1406, 1407 | ✗ | |
| Admin | 1501–1507 | ✗ | Control plane (docs/remaining.md). Eval harness records tokens and cost. |

### Non-functional requirements (summary)

| NFR | Status |
|---|---|
| 101 no production data | ◐ Mocks for declared origins; server preload warns about undeclared hosts; `.env.production` never loaded; safety evals. No egress firewall (cloud). |
| 102 secrets | ◐ Nothing stored; dev logs masked; hooks block secret commits. KMS is cloud. |
| 103 PII scrubber | ✅ Applied to tapes, scenario snapshots, comments. Labelled set (own generator): 100% removed, 0/600 false positives. |
| 105 local only | ✅ By design. |
| 107 GitHub least privilege, no merge | ✅ |
| 109 prompt injection | ◐ Comments are data (skill); the agent cannot resolve, comment, send or share through MCP; T-SAFE-01 eval. |
| 106, 108 SOC 2, pen test | ✗ Not engineering-only. |
| 2xx performance | ◐ Measured: check fast < 20 s, matrix 4 cells < 60 s, state switch re-renders in E2E. Not measured: LCP overhead, cold start (cloud). |
| 601–603 accessibility | ◐ Panel passes axe WCAG 2.2 AA (light + dark); keyboard control tested. No manual screen-reader audit. |

## Evals

Claude Code, headless, on 11 tasks: setup from scratch (Vite, Next.js RSC, a messy repo with an SSO redirect and a required env var), a new product state, a multi-repo design-system change, handling pinned comments, handoff, writing a tape, a seeded visual bug, a prompt injection and a production-key trap.

**Latest run: 10/11 as recorded, 11/11 after one adjudicated checker bug; $7.51 total, median $0.72 and about 2 minutes per task.** The product alone (no agent) passes 0/11. The agent refused the injection and the live key, caught the planted "$NaN" with its own screenshots, and never resolved comments itself.

Small n and fixtures I wrote: smoke signals, not estimates. Details: [evals/results/SUMMARY.md](evals/results/SUMMARY.md). Harness and limits: [evals/README.md](evals/README.md).

## Where this deviates from the PRD

1. **MCP tool names use `_`**, not `.`: the Anthropic and OpenAI APIs only allow `[a-zA-Z0-9_-]`.
2. **No Service Worker.** The runtime patches network APIs before app code runs; a Node preload covers server-side `fetch`.
3. **The mock DB lives in the proxy**, so the app, the panel and the agent share one state, and links fork it.
4. **Tapes start from a known DB** (scenario, or seed + states), so deep links equal playback.
5. **No cookies for sessions**: header, query, then `Referer`. Compare frames and share viewers stay separate in one browser.
6. **Remote clients only reach share-link viewer sessions.** The PRD assumed a cloud with SSO; locally this is the safe default.
7. **The agent is the vision judge.** Checks return screenshots and diffs; there is no separate vision-model service or calibration yet.
