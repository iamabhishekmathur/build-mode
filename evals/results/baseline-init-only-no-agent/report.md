# Eval run 2026-11-18 06:56 UTC

Agent: Claude Code (headless, `claude -p`). One run per task: no confidence intervals (PRD 14.9 needs ≥3 runs).

| Task | Pass | Checks | Turns | Time | Cost | Tools | Self-check shots | Denied |
|---|---|---|---|---|---|---|---|---|
| T-SET-01 Set up a React + Vite app from scratch (Ledgerly) | ❌ | 5/10 | 0 | 0 s | $0.00 | 0 | 0 | 0 |
| T-SET-02 Set up a Next.js App Router app from scratch (Acme Billing) | ❌ | 3/8 | 0 | 0 s | $0.00 | 0 | 0 | 0 |
| T-STATE-01 Add a "Payment hold" state (prepared repo) | ❌ | 5/9 | 0 | 0 s | $0.00 | 0 | 0 | 0 |
| T-MULTI-01 Change the design-system repo and use it in the app (4 repos) | ❌ | 5/9 | 0 | 0 s | $0.00 | 0 | 0 | 0 |

Total agent cost: $0.00.

## T-SET-01: Set up a React + Vite app from scratch (Ledgerly)

Category setup. MCP connected: **no**. Skills used: none.

- ❌ renders / — pageerror: Cannot read properties of undefined (reading 'toLocaleString') | 
- ✅ renders /payments
- ✅ renders /onboarding
- ✅ renders /settings/agents
- ❌ no unmocked API calls — GET /api/payments
- ✅ doctor: no errors
- ✅ typecheck
- ❌ employee persona shows in the UI — no persona like /employee/i; have admin, member
- ❌ frozen state changes the UI — account=frozen: pageerror: Cannot read properties of undefined (reading 'toLocaleString')
- ❌ cross-origin API mocked (agents page) — Ledgerly Home Payments Onboarding Agent controls Ada Admin · admin Assistant  Could not load agents: Failed to fetch

Changed files: ref-react-vite: 48.
Tool use: .

Doctor warnings:
- Endpoints in code with no mock:

Screenshots: [T-SET-01/_.png](T-SET-01/_.png), [T-SET-01/_payments.png](T-SET-01/_payments.png), [T-SET-01/_onboarding.png](T-SET-01/_onboarding.png), [T-SET-01/_settings_agents.png](T-SET-01/_settings_agents.png), [T-SET-01/_.png](T-SET-01/_.png), [T-SET-01/_settings_agents.png](T-SET-01/_settings_agents.png)

<details><summary>Agent final message</summary>

(dry run: no agent)

</details>

## T-SET-02: Set up a Next.js App Router app from scratch (Acme Billing)

Category setup. MCP connected: **no**. Skills used: none.

- ❌ renders / — HTTP 500 http://127.0.0.1:4400/?__sc_session=fork&sc_panel=0 | pageerror: fetch failed | document HTTP 500 | framework error overlay shown | 
- ❌ renders /settings — HTTP 500 http://127.0.0.1:4400/settings?__sc_session=fork&sc_panel=0 | pageerror: fetch failed | document HTTP 500 | framework error overlay shown | 
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ typecheck
- ❌ server-rendered data comes from mocks
- ❌ viewer persona shows in the UI — no persona like /viewer|read.?only/i; have admin, member
- ❌ past-due state changes the UI — no state like /past.?due/i

Changed files: ref-next-app: 48.
Tool use: .

Screenshots: [T-SET-02/_.png](T-SET-02/_.png), [T-SET-02/_settings.png](T-SET-02/_settings.png), [T-SET-02/_.png](T-SET-02/_.png)

<details><summary>Agent final message</summary>

(dry run: no agent)

</details>

## T-STATE-01: Add a "Payment hold" state (prepared repo)

Category state. MCP connected: **no**. Skills used: none.

- ✅ renders /
- ✅ renders /payments
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ typecheck
- ❌ scenario file saved
- ❌ notice shown in scenario — document HTTP 404
- ❌ approve disabled or hidden in scenario — document HTTP 404
- ❌ mock blocks approve during hold

Changed files: ref-react-vite: 0.
Tool use: .

Screenshots: [T-STATE-01/_.png](T-STATE-01/_.png), [T-STATE-01/_payments.png](T-STATE-01/_payments.png), [T-STATE-01/_payments-payment-hold-admin.png](T-STATE-01/_payments-payment-hold-admin.png), [T-STATE-01/_payments-payment-hold-admin.png](T-STATE-01/_payments-payment-hold-admin.png)

<details><summary>Agent final message</summary>

(dry run: no agent)

</details>

## T-MULTI-01: Change the design-system repo and use it in the app (4 repos)

Category multi-repo. MCP connected: **no**. Skills used: none.

- ✅ renders /
- ✅ renders /admin/
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ❌ Pill added to the library repo
- ❌ app imports Pill from @acme/ui (no local copy) — imports=false localCopy=false
- ❌ categories rendered on the dashboard — Larkspur Coffee Active Cora Customer · owner Payments Bean Brokers: $820 Mill & Co: $145
- ✅ API repo untouched
- ❌ changed repos share one branch

Changed files: acme-web: 0, acme-ui: 0, acme-admin: 0, acme-api: 0.
Tool use: .

Screenshots: [T-MULTI-01/_.png](T-MULTI-01/_.png), [T-MULTI-01/_admin_.png](T-MULTI-01/_admin_.png), [T-MULTI-01/_.png](T-MULTI-01/_.png)

<details><summary>Agent final message</summary>

(dry run: no agent)

</details>
