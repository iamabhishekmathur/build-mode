# What is left of the PRD, and how to build it

Everything in this repo runs on one machine: the dev proxy, mocks, the panel, the agent toolkit, checks, evals. What is left needs infrastructure, accounts or people that this environment does not have. For each item: why it is not built, and a concrete design to start from.

## 1. Cloud runtime: microVM driver and fleet (FR-203/204/205, NFR-208)

**Built:** `packages/cloud`. Decision OQ-8 was to build our own. It has orchestrator, snapshots, egress allowlist, edge, API, secrets, sleep/resume and caps, tested on a namespace driver. See [cloud.md](cloud.md).

**Why the rest is not built here:** this container has no `/dev/kvm`.

**To finish:**
- a `FirecrackerDriver` behind the existing `SandboxDriver` interface (jailer, rootfs, tap, vsock agent, snapshot restore);
- a bare-metal fleet and a scheduler;
- Postgres in place of the JSON store;
- the KEK in a KMS;
- a pen test.

The plan is in cloud.md.

## 2. Desktop app (FR-201)

**Why not here:** macOS GUI build and signing.

**Design.** Electron or Tauri shell with three panes:
1. **Agent chat:** the agent CLI in a PTY (`node-pty`), or the Claude Agent SDK for Claude Code.
2. **Live preview:** a webview on the proxy URL, so the panel and comments come for free.
3. **Workspace picker:** reads `stagecraft.config.ts`, runs `stagecraft workspace clone/link`, `report`, `doctor`.

Logs come from `GET /__stagecraft/api/dev/logs`. Runtime switch (local or cloud) points the webview and the PTY at a different proxy. About 4–6 weeks for an MVP shell. The hard parts are already services this app calls.

## 3. Multi-tenant control plane (FR-1402, FR-1501..1507, NFR-102/104/106)

**Why not here:** needs identity providers, Stripe, a database and an audit pipeline.

**Design.**
- Postgres tables: `orgs`, `members(role: org_admin|workspace_admin|builder|viewer)`, `workspaces(repo, github_installation)`, `prototypes(branch, pr)`, `shares`, `feedback`, `usage_events`, `audit_log`.
- RBAC is one policy table checked in one middleware, with a test matrix generated from it (FR-1402 AC).
- **SSO/SCIM (FR-1502):** WorkOS or a similar broker, to get Okta, Entra and Google Workspace in one integration.
- **Billing (FR-1503):** Stripe subscriptions for builder seats. Metered sandbox hours come from orchestrator events, aggregated per minute (AC: invoices match metering to the minute).
- **Spend caps (FR-1505):** a check in the orchestrator before it claims a VM.
- **Audit export (FR-1506):** append-only table, JSON export and a SIEM webhook.
- **Share scopes (FR-1401):** the local share store already handles expiry, passwords, revoke and admin disable. Add an `org` scope (signed-in member) and a `named` scope (email allowlist) once identity exists.

## 4. GitHub App (FR-1101)

**Why not here:** registering an App needs a GitHub organization and its owner. The code is ready (`packages/github`):
- the installation-token provider: JWT, then installation token;
- the least-privilege permission list (`docs/github.md`);
- PR, comment, check and ready-for-review flows, tested against a fake GitHub.

To finish:
1. Register the App with those permissions.
2. Run the test suite against a sandbox org.
3. Confirm the API shapes the module marked as unverified: label permissions, the check-run token type, and `neutral` conclusions.

## 5. Figma, Codex and Cursor end to end (FR-1201/1202, FR-301, FR-307)

**Why not here:** no Figma account or seat, and no Codex or Cursor credentials in this container. Claude Code runs headless here and the evals use it.

**To finish:**
- Add `runCodex` (`codex exec --json`) and `runCursor` (Cursor CLI headless) next to `runClaude` in `packages/evals/src/harness.ts`. The checks are agent-neutral.
- For Figma: a test file with Code Connect on some frames, plus T-FIG tasks that call `check_figma` and `tokens_map`.

## 6. Assurance (NFR-106, NFR-108, NFR-109 red team, NFR-601 manual audit)

Not engineering-only:
- SOC 2 Type I (auditor and controls);
- a third-party pen test of the sandbox layer;
- a manual screen-reader audit (VoiceOver, NVDA).

What exists:
- automated axe checks on the panel;
- two safety evals (prompt injection, production trap);
- the remote-access lock, viewer limits, secret-blocking hooks and the PII scrubber.

## 7. Smaller items not built

| FR | Item | Note |
|---|---|---|
| 406 | Versions: open an older commit live | `git worktree add` at the commit, then serve it as a port-mounted app (the workspace port mount already exists). |
| 708 | Record a tape from a real product-agent session | A proxy recorder on the tape endpoint, piped through `scrub()` (built). |
| 906 | Sync comments to PR review comments | `packages/github` has comment upsert; map each comment to a PR comment with a deep link. |
| 1206 | Send a screen back to Figma | Needs a Figma write API or plugin. |
| 1303 | Generate stories for new components | Template from the component guide's props. |
| 1406 | Static export | `vite build` plus an in-browser mock DB (the handlers would need to run in a Service Worker). |
| 1407 | Research links with recording | Consent screen, rrweb. |
| 606 | Export scenarios as Playwright fixtures | The URL form `?__sc_session=fork&sc_scenario=…` already loads a scenario in a test. |
| 502 | GraphQL and recorded-traffic mocks | The generator has OpenAPI and TS types; GraphQL needs `graphql-js` execution against the seed. |
| 403 | Statsig, Split/Harness | Same pattern as the verified LaunchDarkly, GrowthBook and Unleash mocks. |
| 14.x | Judge calibration, online evals, 150-task suite | Needs human ratings (GD-5, GD-6) and design-partner sessions. |
