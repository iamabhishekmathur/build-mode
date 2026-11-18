---
name: setup
description: Get this repo running on Stagecraft mock data so a designer can prototype. Use when the app does not start, the panel is missing, or API calls fail.
---

# Setup

Goal: the app renders through the Stagecraft proxy with the panel visible and **every** API call served by a mock.

1. Run `npx stagecraft doctor`. Read every line. Fix errors first.
2. Start `npx stagecraft dev`. Open the proxy URL it prints.
3. Call `mock_endpoints`. For each entry in `unmocked`:
   - Find the API type or spec for it (`stagecraft.detect.json` lists specs).
   - Add seed data to `stagecraft/seed.ts` and a handler to `stagecraft/mocks.ts`. Return data that matches the app's types.
4. Common failures and fixes:
   - **Missing env vars**: add safe fake values to `.env.stagecraft`. Never copy values from `.env.production` or a secret store.
   - **Auth redirect loop**: mock the session endpoint (`GET /api/me` or similar) to return the persona user. If the app checks a cookie or token in code, add a dev-only guard on `import.meta.env.STAGECRAFT` / `process.env.STAGECRAFT`.
   - **Wrong Node version**: read `node` in `stagecraft.detect.json`; use the version manager in the repo (`.nvmrc`).
   - **CSP blocks the panel**: the proxy strips CSP in dev. If the app sets CSP in code, guard it behind the dev check.
5. Call `preview_screenshot` on `/`. The page must render real UI, not an error.
6. Report: what works, what you mocked, what still fails and the next action for each.
