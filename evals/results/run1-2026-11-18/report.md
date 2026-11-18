# Eval run 2026-11-18 07:07 UTC

Agent: Claude Code (headless, `claude -p`). One run per task: no confidence intervals (PRD 14.9 needs ≥3 runs).

| Task | Pass | Checks | Turns | Time | Cost | Tools | Self-check shots | Denied |
|---|---|---|---|---|---|---|---|---|
| T-SET-01 Set up a React + Vite app from scratch (Ledgerly) | ✅ | 10/10 | 42 | 109 s | $0.99 | 40 | 7 | 4 |
| T-SET-02 Set up a Next.js App Router app from scratch (Acme Billing) | ✅ | 8/8 | 41 | 90 s | $0.88 | 39 | 6 | 5 |
| T-STATE-01 Add a "Payment hold" state (prepared repo) | ✅ | 9/9 | 37 | 93 s | $0.80 | 35 | 6 | 2 |
| T-MULTI-01 Change the design-system repo and use it in the app (4 repos) | ✅ | 9/9 | 60 | 273 s | $1.06 | 58 | 11 | 7 |

Total agent cost: $3.73.

## T-SET-01: Set up a React + Vite app from scratch (Ledgerly)

Category setup. MCP connected: yes. Skills used: stagecraft-setup.

- ✅ renders /
- ✅ renders /payments
- ✅ renders /onboarding
- ✅ renders /settings/agents
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ typecheck
- ✅ employee persona shows in the UI — persona employee: Ledgerly Home Payments Onboarding Agent controls Eli Employee · employee Assistant Northwind Studio Balance  $48,210.55  Monthly limit  $16,
- ✅ frozen state changes the UI — account=frozen: Ledgerly Home Payments Onboarding Agent controls Ada Admin · admin Assistant This account is frozen. Payments and cards are paused while we 
- ✅ cross-origin API mocked (agents page) — Ledgerly Home Payments Onboarding Agent controls Ada Admin · admin Assistant Agent controls  Decide what each AI agent can do with your money.  Agent	Can do	Spe

Changed files: ref-react-vite: 50.
Tool use: Bash×10, sc:preview_screenshot×7, Write×5, Read×3, ToolSearch×2, sc:persona_set×2, sc:state_set×2, Skill×1, Glob×1, sc:mock_endpoints×1, sc:preview_url×1, sc:scenario_save×1, sc:tape_play×1, sc:tape_validate×1, sc:tape_control×1, sc:mockdb_reset×1.

Permission denials:
- `Bash: {"command":"for f in package.json vite.config.ts .env.stagecraft .gitignore src/*.ts* src/pages/* stagecraft/seed.ts stagecraft/mocks.ts stagecraft/states.ts st`
- `Bash: {"command":"node -e \"console.log(require.resolve('@stagecraft/core'))\" 2>&1; ls ../../../../packages 2>/dev/null","description":"Locate stagecraft core packag`
- `Bash: {"command":"curl -sN --max-time 4 \"http://127.0.0.1:4400/api/assistant/stream?__sc_session=main\" | head -c 3000; echo; echo ---; curl -s -X POST \"http://127.`
- `Bash: {"command":"curl -sN --max-time 4 \"http://127.0.0.1:4400/api/assistant/stream?__sc_session=tapecheck\"","description":"Read assistant chat stream through the p`

Screenshots: [T-SET-01/_.png](T-SET-01/_.png), [T-SET-01/_payments.png](T-SET-01/_payments.png), [T-SET-01/_onboarding.png](T-SET-01/_onboarding.png), [T-SET-01/_settings_agents.png](T-SET-01/_settings_agents.png), [T-SET-01/_.png](T-SET-01/_.png), [T-SET-01/_.png](T-SET-01/_.png), [T-SET-01/_settings_agents.png](T-SET-01/_settings_agents.png)

<details><summary>Agent final message</summary>

The app is running on fake data at **http://127.0.0.1:4400**. Home, Payments, Onboarding and Agent controls all show realistic data, and the admin/employee and active/frozen switches work. The one thing I couldn't look at myself is the open assistant chat panel (details below).

**How to switch views:** use the Stagecraft panel in the app.
- **Who's signed in:** Admin (Ada) or Employee (Eli). Employees see "Waiting for an admin" instead of Approve/Reject.
- **Account:** Active or Frozen. Frozen shows a red banner on every screen. I also added "Over spend limit" and "Under review", because the app already has banners for those.
- **Extra views for prototyping:** no payments yet, nothing to approve, no agents connected, and onboarding just started, halfway or complete.
- **Saved shortcut:** "employee-frozen" opens the Payments screen as Eli with the account frozen.

**What I checked in screenshots:**
- Home, Payments, Onboarding and Agent controls as admin on an active account: all show real data, with no errors or blank screens.
- Payments as employee on a frozen account: the banner shows, and the Approve buttons are replaced by "Waiting for an admin".
- Onboarding at phone width: the layout holds up.

**Assistant chat:** I wrote a scripted conversation. Someone asks to pay Acme Supplies $4,200, the assistant checks the spend limit and drafts the payment, and an Approve/Reject card appears. When you click Approve or Reject, the assistant replies to match. Stagecraft's checker passed the script. While it played, the new Acme payment appeared in the real Payments list, so it is connected to the app's data.
- **Not seen yet:** the chat panel only opens when someone clicks the Assistant button, and my screenshot tool can't click. I also needed your approval to read the chat feed directly, so I haven't seen the messages on screen.
- **To see it:** open the app, pick "Pay a vendor, needs admin approval" in the panel, then click Assistant. I can give you a direct link to a specific step if that's easier.

**Gaps in the app itself (not the fake data):**
- **Agent controls:** employees still see the Pause and Resume buttons. The fake server refuses the change, but the screen shows no message, so clicking just does nothing.
- **Frozen account:** admins still see Approve buttons. Clicking one shows "This account is frozen. Payments are paused." rather than the button being hidden.

I can change either of these if you'd like.

Behind the scenes, all the fake data lives in the Stagecraft mock files (none of it is in the product code), and nothing reaches a real server. Nothing is committed yet.

</details>

## T-SET-02: Set up a Next.js App Router app from scratch (Acme Billing)

Category setup. MCP connected: yes. Skills used: stagecraft-setup.

- ✅ renders /
- ✅ renders /settings
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ typecheck
- ✅ server-rendered data comes from mocks — Acme Billing Invoices Settings Priya Natarajan · owner Northwind Studio  Growth plan · 12 seats  Invoices Bluebird Coffee Roasters	2026-12-01	open	$4,250.00	Mar
- ✅ viewer persona shows in the UI — persona viewer: Acme Billing Invoices Settings Tom Okafor · viewer Settings  Only the account owner can change billing.
- ✅ past-due state changes the UI — account=past_due: Acme Billing Invoices Settings Priya Natarajan · owner Northwind Studio  Growth plan · 12 seats  Your payment method failed. Update it to ke

Changed files: ref-next-app: 50.
Tool use: Bash×11, Read×7, sc:preview_screenshot×6, Write×5, Grep×2, sc:mock_endpoints×2, sc:state_set×2, Skill×1, Glob×1, Edit×1, ToolSearch×1.

Permission denials:
- `Bash: {"command":"for f in stagecraft/seed.ts stagecraft/mocks.ts stagecraft/states.ts .env.stagecraft package.json next.config.mjs app/*.tsx app/settings/* lib/* app`
- `Bash: {"command":"cd /home/user/build-mode && ls; ls packages 2>/dev/null; ls packages/*/ 2>/dev/null; ls packages/*/docs 2>/dev/null; find packages -maxdepth 2 -name`
- `Bash: {"command":"cd /home/user/build-mode/packages && cat server/src/dev-env.ts core/src/types.ts core/src/define.ts","description":"Read Stagecraft dev-env and core`
- `Bash: {"command":"cat > stagecraft/scenarios/past-due-owner.json <<'EOF'\n{\n  \"name\": \"past-due-owner\",\n  \"description\": \"Account owner on a past-due account`
- `Bash: {"command":"curl -sS http://127.0.0.1:4400/__stagecraft/health; echo; curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3100/","description":"Check ex`

Screenshots: [T-SET-02/_.png](T-SET-02/_.png), [T-SET-02/_settings.png](T-SET-02/_settings.png), [T-SET-02/_.png](T-SET-02/_.png), [T-SET-02/_settings.png](T-SET-02/_settings.png), [T-SET-02/_.png](T-SET-02/_.png)

<details><summary>Agent final message</summary>

The billing app now runs entirely on fake data. Both the Invoices and Settings pages load, you can switch between an account owner and a read-only viewer, and you can show a past-due account. I checked each of these with screenshots. I did not try clicking "Mark paid", so that button hasn't been checked yet.

**What was wrong:** the starter setup was faking the wrong addresses. The app gets its data from `api.acme-billing.example`, but the fake data was answering somewhere else. Its user roles were also "admin/member" instead of the app's "owner/viewer". The built-in health check reported everything as fine anyway. Left as it was, the pages would have tried to reach the real billing service and failed. The fake data now answers every request the app makes. The real service is never contacted, and none of the app's own code was changed.

**What you can switch between in the Stagecraft panel:**
- **Personas:**
  - **Account owner** (Priya Natarajan) sees "Mark paid" buttons, and Settings says she can change billing.
  - **Read-only viewer** (Tom Okafor) sees no action buttons, and Settings says only the owner can change billing.
- **Account status:**
  - **Active.**
  - **Past due** shows the yellow "Your payment method failed" banner.
  - **Suspended** shows the red banner and hides all "Mark paid" buttons.
- **Invoices:**
  - **Mixed** (the default) is a fictional company, Northwind Studio, with 7 invoices that are open, overdue or paid.
  - **Empty** is a new account with no invoices.
  - **Several overdue** marks three invoices as overdue.
- **Saved one-click setups:** `past-due-owner` and `past-due-viewer`.

As a viewer, "Mark paid" is refused if the request gets past the hidden button. It's also refused on a suspended account. Marking an invoice paid only changes your own session's fake data.

**What I checked:**
- Screenshots of Invoices and Settings, as owner and as viewer.
- Both saved past-due setups.
- The suspended account combined with no invoices.
- The health check passes, and no request from the app is left without fake data.

I put the shared view back to owner, active account, mixed invoices when I was done.

**To try it:** open http://127.0.0.1:4400 (the Stagecraft address, not port 3100) and use the panel to switch persona and states.

The setup lives in `stagecraft.config.ts` and these files in the `stagecraft/` folder: `seed.ts`, `mocks.ts`, `states.ts` and the two new files in `scenarios/`. Nothing is committed yet.

</details>

## T-STATE-01: Add a "Payment hold" state (prepared repo)

Category state. MCP connected: yes. Skills used: stagecraft-add-state.

- ✅ renders /
- ✅ renders /payments
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ typecheck
- ✅ scenario file saved
- ✅ notice shown in scenario — Ledgerly Home Payments Onboarding Agent controls Ada Okafor · admin Assistant Payments Outgoing payments are on hold for 48 hours. The hold ends Fri, Nov 20, 5:00 PM. No payments will be sent and appr
- ✅ approve disabled or hidden in scenario
- ✅ mock blocks approve during hold

Changed files: ref-react-vite: 7.
Tool use: Bash×9, Edit×6, sc:preview_screenshot×6, Read×3, sc:state_set×3, sc:persona_set×2, Skill×1, Write×1, ToolSearch×1, sc:state_catalog×1, sc:scenario_save×1, sc:scenario_load×1.

Permission denials:
- `Bash: {"command":"python3 - <<'EOF'\nimport re\np='src/api.ts'; s=open(p).read()\ns=s.replace(\"status: 'active' | 'frozen' | 'over_limit' | 'under_review'; balance: `
- `Bash: {"command":"cat > src/pages/Payments.tsx <<'EOF'\nimport { useState } from 'react';\nimport { money, send, useApi, type Account, type Payment, type User } from `

Screenshots: [T-STATE-01/_.png](T-STATE-01/_.png), [T-STATE-01/_payments.png](T-STATE-01/_payments.png), [T-STATE-01/_payments-payment-hold-admin.png](T-STATE-01/_payments-payment-hold-admin.png), [T-STATE-01/_payments-payment-hold-admin.png](T-STATE-01/_payments-payment-hold-admin.png)

<details><summary>Agent final message</summary>

'Payment hold' is now a state you can pick from the Stagecraft panel (Account → Payment hold). The "Payment hold admin" scenario is saved and opens the Payments page. I've loaded that scenario in your preview, so you're looking at it now.

**What admins see on the Payments page during a hold:**
- An amber notice at the top: "Outgoing payments are on hold for 48 hours. The hold ends Fri, Nov 20, 5:00 PM. No payments will be sent and approvals are paused until then. You can still reject requests."
- The Approve buttons are greyed out, and hovering one says why.
- The mock server also refuses approvals during a hold, so this matches how a real backend would behave.

**What I checked in screenshots:**
- **Admin during a hold:** the notice shows and Approve is disabled. At first the disabled buttons only looked slightly faded and still looked clickable, so I made them clearly grey for every disabled button in the app. The only other one is the brief "busy" button on Onboarding.
- **Admin on a normal account:** no notice, and Approve works as before.
- **Employee during a hold:** they see the notice and "On hold" next to each payment. I took "You can still reject requests" out of their version, because only admins can reject.

**Decisions you may want to change:**
- **Reject still works during a hold.** Rejecting doesn't send money, so I left it on. Tell me if it should be blocked too.
- **The notice only appears on the Payments page.** Home and the other pages don't mention the hold, unlike the Frozen and Under review states, which show a banner on every page. I can add one if you want the hold to show everywhere.
- **The hold end time is shown in the viewer's own time zone.** Supporting this meant adding a "hold ends at" date to the account data.

The changes are in `src/pages/Payments.tsx`, `src/api.ts` and `src/styles.css`, plus the mock data, the new state and the scenario in `stagecraft/`. Nothing is committed.

</details>

## T-MULTI-01: Change the design-system repo and use it in the app (4 repos)

Category multi-repo. MCP connected: yes. Skills used: stagecraft-build-screen.

- ✅ renders /
- ✅ renders /admin/
- ✅ no unmocked API calls
- ✅ doctor: no errors
- ✅ Pill added to the library repo
- ✅ app imports Pill from @acme/ui (no local copy) — imports=true localCopy=false
- ✅ categories rendered on the dashboard — Larkspur Coffee Active Cora Customer · owner Payments Bean Brokers: $820Inventory Mill & Co: $145Equipment Paper Cup Depot: $236Supplies Northside Power: $312Utilities Fixit Espresso Repair: $95
- ✅ API repo untouched
- ✅ changed repos share one branch — acme-web@proto/prototype/payment-category-pill, acme-ui@proto/prototype/payment-category-pill

Changed files: acme-web: 4, acme-ui: 1, acme-admin: 0, acme-api: 0.
Tool use: Read×11, sc:preview_screenshot×11, Bash×8, Edit×8, sc:fault_set×8, Glob×2, Skill×1, ToolSearch×1, sc:state_catalog×1, sc:mockdb_reset×1, sc:state_set×1, Grep×1, Write×1, sc:scenario_save×1, sc:mock_endpoints×1, sc:workspace_status×1.

Permission denials:
- `Bash: {"command":"cd .. && ls; for r in acme-web acme-ui acme-admin acme-api; do echo \"== $r\"; (cd $r && git status -sb | head -3 && git ls-files | grep -v node_mod`
- `Bash: {"command":"cd /home/user/build-mode/tests/.tmp/evals/T-MULTI-01-mwlrxr01 && ls && for r in acme-web acme-ui acme-admin acme-api; do echo \"== $r\"; git -C $r s`
- `Bash: {"command":"cd /home/user/build-mode/tests/.tmp/evals/T-MULTI-01-mwlrxr01 && ls && git -C acme-web status -sb && git -C acme-web ls-files && echo == && git -C a`
- `Bash: {"command":"ls -a /home/user/build-mode/tests/.tmp/evals/T-MULTI-01-mwlrxr01/; find /home/user/build-mode/tests/.tmp/evals/T-MULTI-01-mwlrxr01 -path '*/node_mod`
- `Bash: {"command":"curl -s -m 10 -i -H 'x-stagecraft-session: err' \"http://127.0.0.1:4420/v1/payments?__sc_session=err\" | head -20","description":"Request the faulte`
- `Bash: {"command":"node /tmp/claude-0/-home-user-build-mode-tests--tmp-evals-T-MULTI-01-mwlrxr01-acme-web/c712cb05-1893-41ea-9e68-65de15aee720/scratchpad/probe.mjs","t`
- `Bash: {"command":"npx --no tsc --noEmit -p .","timeout":120000,"description":"Type-check the app"}`

Screenshots: [T-MULTI-01/_.png](T-MULTI-01/_.png), [T-MULTI-01/_admin_.png](T-MULTI-01/_admin_.png), [T-MULTI-01/_.png](T-MULTI-01/_.png)

<details><summary>Agent final message</summary>

The Pill component is in the design system, and each payment on the dashboard now shows its category in a Pill. It's mostly ready for handoff, but the error state is not verified: the page didn't finish loading when payments fail, so I have no screenshot of it.

**What changed**
- **Design system (`acme-ui`)**: a new exported `Pill` component, a small rounded label. It's grey by default and has optional `ok`, `warn` and `bad` colours. It uses the existing design tokens and doesn't wrap onto two lines. It sits next to `StatusBadge` in `acme-ui/src/index.tsx`, so any team can import it from `@acme/ui`.
- **Dashboard (`acme-web`)**: each payment shows its category as a grey Pill. A payment with no category shows no pill. I kept them all grey so categories don't look like good or bad statuses.
- **Fake data**: five payments for Larkspur Coffee. Four have a category (Inventory, Equipment, Supplies, Utilities) and one has none, to show that case.
- **States**: the Payments card now has loading, empty ("No payments yet.") and error messages. Before this, a failed payments request blanked the whole page. You can switch to the empty state with a new "No payments" option in the panel.
- **Saved scenario**: `payment-categories`, which opens the dashboard with the categories showing.

**What I checked**
- **Checked in screenshots**: the normal dashboard, the frozen account, a phone-width view, and the empty state all look right.
- **Error state, not verified**: with payments set to fail, the page never finished loading, so the screenshot timed out each time. Before my change, the same test gave a blank page straight away. The new code may be fetching payments over and over. I tried to look closer with a headless browser and to run the type check, but both commands needed your approval, so neither ran. If you approve them, I'll find and fix the cause.
- **Loading message**: not captured, because screenshots wait until the page has finished loading.

**For engineering**
- **Backend dependency**: the real API doesn't return a category yet, and its contract in `acme-api` (which we can't edit) doesn't mention one. The backend needs to add `category`. The dashboard simply hides the pill until then, so it's safe to ship first.
- **Pull requests**: everything is on the branch `proto/prototype/payment-category-pill`. Handoff will be two linked PRs, one for `acme-ui` and one for `acme-web`; `acme-admin` is unchanged.
- **Screenshot files**: the preview screenshots were saved in `acme-web/.stagecraft-cache/` and show up as changes. They should be left out of the PR.
- I haven't committed or opened any PRs. When you're ready, I can run the handoff skill to clean up, run checks and write the PR descriptions.

</details>
