---
name: handoff
description: Prepare a prototype for an engineer: clean variants, check for mock leakage, run checks, and write the PR description.
---

# Handoff

1. **Variants:** ask the user which option won for each variant (`variant_list`). Replace each `<Variant>` / `useVariant` with the winning code only. No `@stagecraft/react` variant calls may remain for those regions.
2. **Mock leakage:** product code must not import from `stagecraft/`. Run `npx --no stagecraft doctor`; it fails on leaks.
3. **Checks:** run `check_handoff` (build, types, lint, tests, no mock code, no variants left, components clean). All must pass, or explain why in the PR.
4. **Design system:** no new component that duplicates an existing one; no hard-coded colors or spacing. Explain any exception.
5. **PR description:** `pr_describe` writes it (run with `runGate: true`). Check and edit it. It has these sections:
   - Summary (what and why)
   - Screens changed (with screenshots from `preview_screenshot`)
   - States covered (list scenarios in `stagecraft/scenarios/`)
   - Tapes (if any)
   - Figma links
   - Mocked endpoints the backend must build (from `mock_endpoints` and new handlers in `stagecraft/mocks.ts`)
   - Known gaps
6. **Multi-repo products:** call `workspace_status`. Every changed repo gets its own PR on the same branch name. Library PRs (for example the design system) merge first; app PRs depend on them. Link the PRs to each other in their descriptions. Read-only repos (the API) must have no changes: list the backend work in the app PR instead.
7. Do not merge and do not mark the PR ready yourself. A human does that.
