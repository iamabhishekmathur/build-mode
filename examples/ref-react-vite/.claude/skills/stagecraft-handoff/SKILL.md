---
name: handoff
description: Prepare a prototype for an engineer: clean variants, check for mock leakage, run checks, write the PR description, post the preview comment, and mark the PR ready for engineering when the user asks.
---

# Handoff

1. **Variants:** ask the user which option won for each variant (`variant_list`). Replace each `<Variant>` / `useVariant` with the winning code only. No `@stagecraft/react` / `@stagecraft/vue` variant calls may remain for those regions.
2. **Mock leakage:** product code must not import from `stagecraft/`. Run `npx --no stagecraft doctor`; it fails on leaks.
3. **Checks:** run `check_handoff` (build, types, lint, tests, no mock code, no variants left, components clean). All must pass, or explain why in the PR.
4. **Design system:** no new component that duplicates an existing one; no hard-coded colors or spacing. Explain any exception.
5. **PR description:** `pr_describe` writes it (run with `runGate: true`). Check and edit it, save it to `.stagecraft-cache/pr.md`, and pass it to `npx --no stagecraft pr open --body-file .stagecraft-cache/pr.md`. It has these sections:
   - Summary (what and why)
   - Screens changed (with screenshots from `preview_screenshot`)
   - States covered (list scenarios in `stagecraft/scenarios/`)
   - Tapes (if any)
   - Figma links
   - Mocked endpoints the backend must build (from `mock_endpoints` and new handlers in `stagecraft/mocks.ts`)
   - Known gaps
6. **Save to the draft PR:** `npx --no stagecraft pr open --title "<title>" --body-file .stagecraft-cache/pr.md` (MCP: `github_pr_open`). It commits with the user as author and you as co-author, pushes the `proto/<user>/<slug>` branch and creates or updates the draft PR. Run it again after every change; it never opens a second PR.
7. **Preview comment:** after every push, `npx --no stagecraft pr comment --preview-url <url> --screenshot <state-matrix image URL or committed file> --body-file <notes>` (MCP: `github_pr_comment`). It edits the one Stagecraft comment in place and sets the `Stagecraft` check. Never post your own preview comments with other tools.
8. **Multi-repo products:** call `workspace_status`, then `npx --no stagecraft pr open --workspace` from the host repo. Every changed writable repo gets its own PR on the same branch name, library PRs first, and each PR lists the others under "Related PRs". Read-only repos (the API) must have no changes: list the backend work in the app PR instead.
9. **Ready for engineering:** only when the user asks. Run `npx --no stagecraft pr ready` (MCP: `github_pr_ready`). It runs the handoff gate and moves the PR out of draft only if the gate passes. If it fails, show the user the reasons and fix them. Use `--override "<reason>"` only when the user gives a reason in their own words; the reason is recorded in the PR.
10. **Never merge.** Stagecraft has no merge command. An engineer reviews and merges under the repo's branch protection.
