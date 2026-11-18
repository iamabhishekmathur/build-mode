---
name: setup
description: Get this repo running on Stagecraft mock data so a designer can prototype. Use when the app does not start, the panel is missing, or API calls fail.
---

# Setup

Goal: the app renders through the Stagecraft proxy with the panel visible and **every** API call served by a mock.

1. Run `npx --no stagecraft doctor`. Read every line. Fix errors first.
2. Start `npx --no stagecraft dev`.
   - `stagecraft init` wrote **placeholder** personas and states (labels end in "(placeholder)"). Replace them with the product's real roles and states. Use the user's own words: if they say "employee", the persona, its seed user's role and what the UI shows must say employee, not "member". Open the proxy URL it prints.
3. **If the repo has an OpenAPI spec** (`stagecraft.detect.json` → `apiSpecs`, or an `api` repo in the workspace), generate mocks first, then hand-tune:
   ```bash
   npx --no stagecraft mocks generate --openapi path/to/openapi.yaml   # or: --types src/api.ts --type Invoice:/v1/invoices
   ```
   It writes `stagecraft/generated/` (types, deterministic seed, a handler for every operation, edge states: empty, one, many, long text, RTL, unicode) and prints the lines to add. Spread `generatedSeed()`, `generatedHandlers` and `generatedStates` first in `seed.ts`, `mocks.ts` and `states.ts`; your own keys after the spread win. Never edit files in `stagecraft/generated/`: regenerate instead. Then replace generic data with the product's real words (persona users, account names, the statuses the UI shows).
4. Call `mock_endpoints`. For each entry in `unmocked`:
   - Find the API type or spec for it (`stagecraft.detect.json` lists specs).
   - Add seed data to `stagecraft/seed.ts` and a handler to `stagecraft/mocks.ts`. Return data that matches the app's types.
   Handler API (`stagecraft/mocks.ts`), so you do not need to read Stagecraft's source:
   ```ts
   export const handlers = defineHandlers<DB>({
     // Keys: "METHOD /path/:param". "*" matches any method. Paths only, no origin.
     'GET /v1/invoices/:id': ({ db, params, query, body, headers, persona, flags, states, reply }) => {
       const inv = db.invoices.find((i) => i.id === params.id);
       if (!inv) return reply(404, { error: 'Not found' });   // reply(status, body?, headers?)
       return inv;                                             // plain value → 200 JSON; undefined → 204
     },
   });
   ```
   - `db` is the live mock DB for the viewer's session: mutate it to persist writes.
   - `persona` is the selected persona plus its `id` (`persona.userId`, `persona.role`…).
   - `apiOrigins` in `stagecraft.config.ts` lists what is mocked: paths (`/api`) for same-origin calls, full origins (`https://api.example.com`) for other hosts. Server-side `fetch` (SSR, React Server Components) to those origins is mocked too.
5. Common failures and fixes:
   - **Missing env vars**: add safe fake values to `.env.stagecraft`. Never copy values from `.env.production` or a secret store.
   - **Auth redirect loop**: mock the session endpoint (`GET /api/me` or similar) to return the persona user. If the app checks a cookie or token in code, add a dev-only guard on `import.meta.env.STAGECRAFT` / `process.env.STAGECRAFT`.
   - **Wrong Node version**: read `node` in `stagecraft.detect.json`; use the version manager in the repo (`.nvmrc`).
   - **CSP blocks the panel**: the proxy strips CSP in dev. If the app sets CSP in code, guard it behind the dev check.
6. Call `preview_screenshot` on `/`. The page must render real UI, not an error.
7. Report: what works, what you mocked, what still fails and the next action for each.
