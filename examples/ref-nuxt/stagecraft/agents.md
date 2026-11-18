# Stagecraft prototyping rules

This repo is set up for prototyping with Stagecraft. The app runs on **mock data** through the Stagecraft proxy. Designers and PMs prototype here. Your changes must be real, shippable code.

## Run it
- Start: `npx --no stagecraft dev` (starts the dev server and the proxy). Open the proxy URL, not the dev server URL.
- The `stagecraft` MCP server gives you tools: `state_catalog`, `state_set`, `persona_set`, `flags_set`, `variant_select`, `scenario_save`, `scenario_load`, `mockdb_query`, `mockdb_seed`, `mock_endpoints`, `fault_set`, `tape_create`, `tape_play`, `preview_screenshot`.
- If a tool says the proxy is not running, start it. Do not ask the user to run commands.

## Hard rules
1. **No production data or secrets.** Never add real API hosts, keys or connection strings. All API calls are served by mocks in `stagecraft/`.
2. **Mock code stays in `stagecraft/`.** Product code must never import from `stagecraft/`. Product code may import `@stagecraft/react` or `@stagecraft/vue` (no-ops in production).
3. **Use the design system.** Before you make a new component, read `stagecraft/component-guide.md` (or call `components_guide`; regenerate with `npx --no stagecraft guide`). Use design tokens, not hard-coded colors or spacing.
4. **Every new endpoint needs a mock.** Add a handler in `stagecraft/mocks.ts` and seed data in `stagecraft/seed.ts`. Check `mock_endpoints` for requests with no mock.
5. **Every new screen needs its states.** Empty, loading, error, and each product state that changes the screen. Add states to `stagecraft/states.ts`.
6. **Check your work visually.** After a UI change, call `preview_screenshot` for each changed screen in the states that matter. Fix what you see before you say you are done.
7. **Options go in variants, not branches.** When asked for options, wrap the region in `<Variant>` from `@stagecraft/react` (`options={{ A: ..., B: ... }}`) or `@stagecraft/vue` (one named slot per option).
8. **Do not merge, deploy or make links public.** Those need a human.

## Where things are
- `stagecraft.config.ts`: proxy config, API origins, personas, flags.
- `stagecraft/seed.ts`: initial mock DB. `stagecraft/mocks.ts`: request handlers. `stagecraft/states.ts`: state catalog.
- `stagecraft/scenarios/*.json`: saved scenarios. `stagecraft/tapes/*.json`: product-agent conversation tapes.

## Skills
Use the skills in your skills folder: `setup`, `build-screen`, `add-state`, `create-variant`, `apply-figma-frame`, `make-tape`, `self-check`, `handle-feedback`, `handoff`.
- When people leave comments in the panel, they reach you through `feedback_list`. Reply with `feedback_reply`; never resolve comments yourself.
