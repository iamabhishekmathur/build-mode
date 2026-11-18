---
name: build-screen
description: Build or change a screen in the real product with real design-system components, mock data and all its states.
---

# Build a screen

1. Call `state_catalog` to learn personas, states and flags.
2. Find 2–3 similar existing screens. Copy their structure, data hooks, components and tokens. Do not invent new patterns.
3. If you need data the API does not have: add it to `stagecraft/seed.ts`, add a handler in `stagecraft/mocks.ts`, and add the type where the app keeps API types.
4. Build the screen. Use design-system components. No hard-coded colors, font sizes or spacing.
5. Cover states: empty, loading, error (use `fault_set` with a 500 to test), and each product state that changes the screen. Add missing ones with the `add-state` skill.
6. Run the type check and lint for changed files.
7. Run the `self-check` skill. Fix what it finds.
8. Save a scenario for the main state with `scenario_save` (`url` = the route).
