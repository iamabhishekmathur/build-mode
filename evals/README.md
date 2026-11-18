# Evals (harness v0)

PRD Section 14 says product quality is measured by evals. This is the first harness.

```bash
node packages/evals/src/cli.ts --list        # tasks
node packages/evals/src/cli.ts --dry         # no agent: baseline of what the product does alone
node packages/evals/src/cli.ts [T-SET-01 …]  # run Claude Code headless; ≈ $1 and 2–5 min per task
```

## What one task run does

1. Copies the fixture repo(s) to `tests/.tmp/evals/…`. Each folder becomes its own git repo, like a customer checkout.
2. Setup tasks (`strip: true`) delete every Stagecraft file, then run `stagecraft init`, which is the product's own deterministic step. The agent must finish setup.
3. Starts `stagecraft dev` (proxy + the app's dev server).
4. Runs `claude -p "<synthetic user prompt>"` in the host repo. The agent gets the repo's **own generated** `.mcp.json`, `.claude/settings.json`, `AGENTS.md` and skills, plus an allowlist (edit files, Stagecraft MCP, `npx --no stagecraft`, `npx tsc`, read-only git).
5. Stops everything and starts a **fresh** proxy and dev server, so nothing left over from the agent's session counts.
6. Checks, all automatic:
   - every task route renders: no page errors, no 5xx, no framework error overlay;
   - no unmocked API calls after visiting the routes;
   - `stagecraft doctor` has no errors;
   - typecheck passes;
   - task checks look for **evidence in the rendered UI**: a state or persona is selected in a forked session, and the page must change accordingly.
7. Writes `results.json`, `report.md`, screenshots and the full agent transcript.

## Tasks

| ID | Category | Fixture | What the synthetic user asks |
|---|---|---|---|
| T-SET-01 | setup | `ref-react-vite`, Stagecraft removed | Make every screen work on fake data; admin/employee; active/frozen |
| T-SET-02 | setup | `ref-next-app` (Next 16 RSC), Stagecraft removed | Same for a server-rendered app; owner/viewer; past due |
| T-STATE-01 | state | `ref-react-vite` | Add a "Payment hold" state, notice, block approvals, save a scenario |
| T-MULTI-01 | multi-repo | 4 repos | Add a `Pill` to the design-system repo and use it in the app |

## Limits of v0 (be careful with the numbers)

- **Small n.** 4 tasks, 3 runs each. PRD target is about 150 tasks. Treat pass rates as smoke signals, not estimates.
- **Our own fixtures.** I wrote the apps, so they are cleaner than real repos (typed API calls, `data-testid`s, `@stagecraft/react` already in product code). The PRD's messy-repo suite (RR-M1…M7) and real open-source apps (OQ-11) are the next step.
- **One prompt, no conversation.** The synthetic designer (PRD 14.3) does not reply yet; there is no human-intervention metric (E-9).
- **Claude Code only.** Codex and Cursor runners are not written.
- **Fixtures sit inside this monorepo**, so an agent could read the original example answers. The run-1 audit found none; the agent read only Stagecraft's library source. A future harness should run fixtures outside the monorepo.
