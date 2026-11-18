# Eval run 2026-11-18 07:24 UTC

Agent: Claude Code (headless, `claude -p`). One run per task: no confidence intervals (PRD 14.9 needs ≥3 runs).

| Task | Pass | Checks | Turns | Time | Cost | Tools | Self-check shots | Denied |
|---|---|---|---|---|---|---|---|---|
| T-SET-01 Set up a React + Vite app from scratch (Ledgerly) | ❌ | 9/10 | 53 | 234 s | $1.26 | 50 | 11 | 4 |
| T-SET-02 Set up a Next.js App Router app from scratch (Acme Billing) | ✅ | 8/8 | 37 | 81 s | $0.72 | 35 | 8 | 3 |
| T-STATE-01 Add a "Payment hold" state (prepared repo) | ✅ | 9/9 | 36 | 112 s | $0.72 | 34 | 5 | 3 |
| T-MULTI-01 Change the design-system repo and use it in the app (4 repos) | ✅ | 9/9 | 62 | 154 s | $1.01 | 60 | 7 | 6 |

Total agent cost: $3.73.

## T-SET-01: Set up a React + Vite app from scratch (Ledgerly)

Category setup. MCP connected: yes. Skills used: stagecraft-setup, stagecraft-make-tape.

- ✅ renders /
- ✅ renders /payments
- ✅ renders /onboarding
- ✅ renders /settings/agents
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ typecheck
- ❌ employee persona shows in the UI — persona member: Ledgerly Home Payments Onboarding Agent controls Max Brennan · member Assistant Northwind Studio Balance  $48,210.55  Monthly limit  $14,380
- ✅ frozen state changes the UI — account=frozen: Ledgerly Home Payments Onboarding Agent controls Ada Okafor · admin Assistant This account is frozen. Payments and cards are paused while we
- ✅ cross-origin API mocked (agents page) — Ledgerly Home Payments Onboarding Agent controls Ada Okafor · admin Assistant Agent controls  Decide what each AI agent can do with your money.  Agent	Can do	Sp

Changed files: ref-react-vite: 49.
Tool use: sc:preview_screenshot×11, Bash×10, Grep×8, Edit×3, Read×3, Skill×2, Write×2, sc:mock_endpoints×2, sc:tape_play×2, ToolSearch×1, sc:tape_create×1, sc:state_catalog×1, sc:persona_set×1, sc:state_set×1, sc:mockdb_reset×1, sc:preview_url×1.

Permission denials:
- `Bash: {"command":"for f in src/*.ts* src/pages/* stagecraft/seed.ts stagecraft/mocks.ts stagecraft/states.ts .env.stagecraft package.json vite.config.ts; do echo \"==`
- `Bash: {"command":"python3 - <<'EOF'\np='stagecraft.config.ts'\ns=open(p).read()\ns=s.replace(\"apiOrigins: ['/api'],\",\"apiOrigins: ['/api', 'https://api.ledgerly.ex`
- `Bash: {"command":"curl -sS -N --max-time 3 'http://127.0.0.1:4400/api/assistant/stream?__sc_session=chat' -H 'accept: text/event-stream' | head -c 3000; echo; echo EX`
- `Bash: {"command":"curl -sS -N --max-time 3 -H 'accept: text/event-stream' 'http://127.0.0.1:4400/api/assistant/stream?__sc_session=chat'","description":"Read the mock`

Screenshots: [T-SET-01/_.png](T-SET-01/_.png), [T-SET-01/_payments.png](T-SET-01/_payments.png), [T-SET-01/_onboarding.png](T-SET-01/_onboarding.png), [T-SET-01/_settings_agents.png](T-SET-01/_settings_agents.png), [T-SET-01/_.png](T-SET-01/_.png), [T-SET-01/_.png](T-SET-01/_.png), [T-SET-01/_settings_agents.png](T-SET-01/_settings_agents.png)

<details><summary>Agent final message</summary>

The app is running on fake data at **http://127.0.0.1:4400/**. Home, Payments, Onboarding, Agent controls and the assistant chat all work, and none of them talk to a real backend. I checked each one with screenshots and clicked through the main actions.

**Switching who you are and the account status:** open the Stagecraft panel on the page.
- **Admin / Employee:** the admin is Ada Okafor and the employee is Max Brennan. An admin sees Approve/Reject buttons on payments. An employee sees "Waiting for an admin" and is blocked from approving or from pausing agents.
- **Active / Frozen:** Frozen shows the red "This account is frozen" banner on every screen, and approving a payment returns an "account is frozen" error.

**What's on each screen:**
- **Home:** a company called Northwind Studio with a $48,210.55 balance, a monthly limit bar at 58% used, and recent payments.
- **Payments:** seven payments to vendors like AWS, Figma and WeWork. Two are waiting for approval; approving or rejecting one updates the list straight away.
- **Onboarding:** the admin is on step 3 of 4 and the employee on step 2. "Complete step" moves forward through to "Onboarding complete."
- **Agent controls:** three AI agents (Bookkeeper, Bill Pay Assistant, Travel Booker) that you can pause and resume.
- **Assistant chat:** a scripted conversation where you ask it to pay an Adobe invoice. It checks your spend, drafts the payment and shows an approval card. Approve or Reject in the chat and it replies to match, and the payment shows up in Payments. To jump straight to the approval card, open http://127.0.0.1:4400/?sc_tape=vendor-payment-approval&sc_step=9 and click **Assistant**.

Your changes stay in your own session. To start fresh, use the reset option in the panel. If you play the scripted conversation more than once, an extra Adobe payment from the earlier run can stay in the list until you reset.

What I changed, so an engineer can review it later:
- `stagecraft/seed.ts`: the fake data.
- `stagecraft/mocks.ts`: the fake responses, including the admin-only and frozen-account rules.
- `stagecraft.config.ts`: renamed "Member" to "Employee", added fake data for the Agent controls page (it talks to a separate server), and connected the chat to the scripted conversation.
- `stagecraft/tapes/vendor-payment-approval.json`: the scripted conversation.

I didn't change any of the app's own screens. Stagecraft's health check passes with every call the app makes now answered by fake data, and the code type-check passes. Nothing is committed yet.

</details>

## T-SET-02: Set up a Next.js App Router app from scratch (Acme Billing)

Category setup. MCP connected: yes. Skills used: stagecraft-setup.

- ✅ renders /
- ✅ renders /settings
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ typecheck
- ✅ server-rendered data comes from mocks — Acme Billing Invoices Settings Priya Raman · owner Northwind Studio  Growth plan · 12 seats  Invoices Bluebird Coffee	2026-12-01	open	$1,840.00	Mark paid Harbor
- ✅ viewer persona shows in the UI — persona viewer: Acme Billing Invoices Settings Tom Becker · viewer Settings  Only the account owner can change billing.
- ✅ past-due state changes the UI — account=past_due: Acme Billing Invoices Settings Priya Raman · owner Northwind Studio  Growth plan · 12 seats  Your payment method failed. Update it to keep s

Changed files: ref-next-app: 51.
Tool use: Bash×8, sc:preview_screenshot×8, Write×3, sc:scenario_save×3, sc:state_set×3, Read×2, sc:persona_set×2, Skill×1, Glob×1, Edit×1, ToolSearch×1, sc:state_catalog×1, sc:mock_endpoints×1.

Permission denials:
- `Bash: {"command":"for f in app/*.tsx app/settings/page.tsx app/globals.css lib/api.ts package.json next.config.mjs .env.stagecraft .gitignore stagecraft/agents.md; do`
- `Bash: {"command":"P=$(node -p \"require('path').dirname(require.resolve('@stagecraft/core/package.json'))\"); echo $P; ls $P $P/src 2>/dev/null; grep -rn \"defineStat`
- `Bash: {"command":"node -p \"require('path').dirname(require.resolve('@stagecraft/core/package.json'))\"","description":"Locate @stagecraft/core package"}`

Screenshots: [T-SET-02/_.png](T-SET-02/_.png), [T-SET-02/_settings.png](T-SET-02/_settings.png), [T-SET-02/_.png](T-SET-02/_.png), [T-SET-02/_settings.png](T-SET-02/_settings.png), [T-SET-02/_.png](T-SET-02/_.png)

<details><summary>Agent final message</summary>

I finished the setup, and it works. The Invoices and Settings pages now load fake data for an account owner and a read-only viewer, and you can switch the account to past-due. I checked each of these in screenshots.

**What was wrong:** Stagecraft's starter setup was faking the wrong addresses. The app gets its data from `https://api.acme-billing.example/v1/...`, but the fake data was answering `/api/...`. The starter roles were also "admin" and "member", while the app only knows "owner" and "viewer". Stagecraft's own health check passed anyway, because it doesn't catch this kind of mismatch.

**What I set up:**
- **Fake company "Northwind Studio"** on the Growth plan with 12 seats, and six invoices: two open, one overdue, three paid.
- **Two people to switch between:**
  - **Account owner (Priya):** sees a "Mark paid" button on unpaid invoices, and Settings says she can change billing.
  - **Read-only viewer (Tom):** sees the same invoices with no buttons, and Settings says only the owner can change billing.
- **"Mark paid" really works:** the invoice changes to paid. The fake server also refuses it for a viewer or a suspended account.
- **Account states you can switch between:**
  - **Past due:** a yellow "Your payment method failed" banner appears, and a second invoice becomes overdue.
  - **Suspended:** a red banner appears, and the "Mark paid" buttons disappear.
  - **No invoices:** shows the empty message.
- **Three saved setups** you can open in one click: `owner-active`, `viewer-read-only` and `past-due-owner`.

**What I checked:** No request from the app goes to a real server. I took screenshots of both pages for the owner, the viewer and the past-due account, plus the suspended and no-invoices states. I also clicked "Mark paid" to confirm the invoice updates. Everything showed what it should.

**How to use it:** Open http://127.0.0.1:4400 (not port 3100). The Stagecraft panel there lets you switch between the owner and the viewer, change the account state, or load a saved setup. I left it on the owner with an active account.

Two things you might notice:
- **Settings page:** it's very thin. It only shows one line about who can change billing. If you want to try a real billing settings screen, that's something we'd build next.
- **Small round "N" button:** it appears bottom-left of the page, sometimes over the content, and comes from the development tools. Your customers won't see it.

Nothing is committed yet. The changes are in `stagecraft.config.ts` and the `stagecraft/` folder.

</details>

## T-STATE-01: Add a "Payment hold" state (prepared repo)

Category state. MCP connected: yes. Skills used: stagecraft-add-state.

- ✅ renders /
- ✅ renders /payments
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ typecheck
- ✅ scenario file saved
- ✅ notice shown in scenario — Ledgerly Home Payments Onboarding Agent controls Ada Okafor · admin Assistant Payments Outgoing payments are on hold for 48 hours. Payments resume Fri, Nov 20, 5:00 PM. Until then, no payments can be 
- ✅ approve disabled or hidden in scenario
- ✅ mock blocks approve during hold

Changed files: ref-react-vite: 7.
Tool use: Edit×9, Read×7, Bash×6, sc:preview_screenshot×5, sc:state_set×2, Skill×1, ToolSearch×1, sc:state_catalog×1, sc:persona_set×1, sc:scenario_save×1.

Permission denials:
- `Bash: {"command":"python3 - <<'EOF'\nimport re\ndef sub(path, old, new):\n    s=open(path).read(); assert old in s, (path, old); open(path,'w').write(s.replace(old,ne`
- `Bash: {"command":"npx --no tsc --noEmit -p . 2>&1 | tail -20; echo exit=$?","description":"Type-check the project"}`
- `Bash: {"command":"npx --no tsc --noEmit -p . 2>&1 | tail -20","description":"Type-check the project"}`

Screenshots: [T-STATE-01/_.png](T-STATE-01/_.png), [T-STATE-01/_payments.png](T-STATE-01/_payments.png), [T-STATE-01/_payments-payment-hold-admin.png](T-STATE-01/_payments-payment-hold-admin.png), [T-STATE-01/_payments-payment-hold-admin.png](T-STATE-01/_payments-payment-hold-admin.png)

<details><summary>Agent final message</summary>

I added the 'Payment hold' account state, built the Payments page notice, and saved the 'Payment hold admin' scenario. I checked it in screenshots and it looks right.

**What you'll see**
- **In the panel:** "Payment hold" is now an option under **Account**, next to Active, Frozen, Over limit and Under review.
- **On Payments:** a yellow warning notice at the top reads "**Outgoing payments are on hold for 48 hours.** Payments resume Fri, Nov 20, 5:00 PM. Until then, no payments can be approved or sent."
- **Approve buttons:** they're greyed out and can't be clicked, with a "Payments are on hold" tooltip. Screen readers announce them as linked to the notice. Reject still works, since you only asked to block approvals.
- **Behind the button:** the mock server also refuses approvals during a hold and returns an error, so it's blocked even if something gets past the button.

**The scenario:** "Payment hold admin" opens `/payments` as the admin (Ada), with the hold on and two payments waiting for approval. It's saved in `stagecraft/scenarios/payment-hold-admin.json`.

**What I checked**
- On desktop and phone widths, the notice and the disabled buttons show up as expected.
- In my first look, the disabled Approve button was only slightly faded and still looked clickable. I restyled it so it clearly reads as unavailable.
- I switched back to **Active** and confirmed there's no notice and Approve works as before.
- I loaded the saved scenario fresh and it opens in the right state.

**Things to know**
- **Notice placement:** it appears only on the Payments page, as you asked. Other account states like Frozen show a banner at the top of every page; I can do that for the hold too if you want.
- **The resume date is fixed** at Nov 20, 5:00 PM UTC, which is 48 hours from today. It's shown in the viewer's local time.
- **Not type-checked:** the TypeScript check needed a permission I didn't have, so it hasn't been run. Run `npx tsc --noEmit` once before handing this off.

**Files changed:**
- `stagecraft/states.ts`: the new state
- `stagecraft/seed.ts` and `src/api.ts`: a new hold end-date field
- `stagecraft/mocks.ts`: approvals blocked during a hold
- `src/pages/Payments.tsx`: the notice and disabled button
- `src/styles.css`: disabled-button styling, using the existing design tokens

</details>

## T-MULTI-01: Change the design-system repo and use it in the app (4 repos)

Category multi-repo. MCP connected: yes. Skills used: stagecraft-build-screen.

- ✅ renders /
- ✅ renders /admin/
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ Pill added to the library repo
- ✅ app imports Pill from @acme/ui (no local copy) — imports=true localCopy=false
- ✅ categories rendered on the dashboard — Larkspur Coffee Active Cora Customer · owner Payments Bean Brokers: $820 Supplies Mill & Co: $145 Equipment Brightline Electric: $312 Utilities Paper Trail Packaging: $96 Supplies Steamworks Repair: $
- ✅ API repo untouched
- ✅ changed repos share one branch — acme-web@proto/pill-payment-category, acme-ui@proto/pill-payment-category

Changed files: acme-web: 5, acme-ui: 1, acme-admin: 0, acme-api: 0.
Tool use: Edit×13, Read×12, Bash×8, sc:preview_screenshot×7, Glob×6, Write×3, sc:fault_set×2, sc:state_set×2, Skill×1, ToolSearch×1, sc:state_catalog×1, sc:mockdb_reset×1, sc:mock_endpoints×1, sc:scenario_save×1, sc:workspace_status×1.

Permission denials:
- `Bash: {"command":"cd .. && ls; for r in acme-web acme-ui acme-admin acme-api; do echo \"== $r\"; (cd $r && git status -sb | head -3 && git ls-files | grep -v node_mod`
- `Bash: {"command":"cd /home/user/build-mode/tests/.tmp/evals/T-MULTI-01-mwlslt4l && ls && for r in acme-web acme-ui acme-admin acme-api; do echo \"== $r\"; git -C $r s`
- `Bash: {"command":"cd /home/user/build-mode/tests/.tmp/evals/T-MULTI-01-mwlslt4l; ls; git -C acme-web status -sb; git -C acme-ui status -sb; git -C acme-web ls-files; `
- `Bash: {"command":"ls -la /home/user/build-mode/tests/.tmp/evals/T-MULTI-01-mwlslt4l/ /home/user/build-mode/tests/.tmp/evals/T-MULTI-01-mwlslt4l/acme-ui /home/user/bui`
- `Bash: {"command":"cat package.json; ls; npx --no tsc --noEmit -p . 2>&1 | tail -20","description":"Show scripts and run type check"}`
- `Bash: {"command":"npx --no tsc --version 2>&1","description":"Check TypeScript is available"}`

Screenshots: [T-MULTI-01/_.png](T-MULTI-01/_.png), [T-MULTI-01/_admin_.png](T-MULTI-01/_admin_.png), [T-MULTI-01/_.png](T-MULTI-01/_.png)

<details><summary>Agent final message</summary>

I added the Pill component to the design system and the dashboard now shows each payment's category with it. Everything is on a branch called `proto/pill-payment-category` and nothing is committed or pushed yet. I checked the dashboard in screenshots in every state below. This repo has no build, type-check, lint or test scripts, so those didn't run. The only automated check was Stagecraft's own check, and it passed.

**The Pill component (design-system repo, `acme-ui`)**
- `<Pill>Supplies</Pill>` is a small rounded label. It has an optional `tone`: neutral (the default), brand, ok, warn or bad.
- It uses only the existing design colors and spacing, and has the same shape as the existing status badge (Active / Frozen), so they look like a set.
- It's exported from the package, so other teams can import it like any other component.

**Dashboard (`acme-web`)**
- Each payment shows a grey Pill with its category. I added four more fake payments, so the list covers Supplies, Equipment, Utilities, Maintenance and Rent.
- A payment with no category simply shows no pill.
- **I fixed a bug that was already there:** if payments failed to load, the whole page went blank. The payments card now shows a loading message, a "No payments yet." message and an error message instead.
- In the Stagecraft panel you can now switch between "With payments", "No payments" and "No categories". There's also a new saved scenario called `payment-categories`.
- Mock screenshots no longer show up as changed files, so they won't end up in the PR.

**For engineering**
- **Backend work is needed:** the real payments API has no category field yet. The dashboard handles that by showing no pill, but someone has to add the field. They also need to decide whether categories are free text or a fixed list. I couldn't record this in the API repo because that repo is read-only.
- I drafted one PR description per changed repo. The design-system PR merges first and the dashboard PR depends on it:
  - `/tmp/claude-0/-home-user-build-mode-tests--tmp-evals-T-MULTI-01-mwlslt4l-acme-web/119a5a19-8a29-42ee-920b-6de43e613b1c/scratchpad/PR-acme-ui.md`
  - `/tmp/claude-0/-home-user-build-mode-tests--tmp-evals-T-MULTI-01-mwlslt4l-acme-web/119a5a19-8a29-42ee-920b-6de43e613b1c/scratchpad/PR-acme-web.md`

Should I commit, push and open the two draft PRs linked to each other? Merging them is left to a person.

</details>
