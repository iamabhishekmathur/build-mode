# Eval summary: 3 runs × 4 tasks (Claude Code, headless)

Run 1 used the first `preview_screenshot`; runs 2–3 used the fixed one (settle + actions). Same tasks, same checks. n = 3 per task: smoke signal, not an estimate.

| Task | Passed | Checks passed | Median turns | Median time | Median cost | Self-check screenshots (median) |
|---|---|---|---|---|---|---|
| T-SET-01 Set up a React + Vite app from scratch (Ledgerly) | 2/3 | 29/30 | 53 | 234 s | $1.26 | 11 |
| T-SET-02 Set up a Next.js App Router app from scratch (Acme Billing) | 3/3 | 24/24 | 41 | 90 s | $0.79 | 8 |
| T-STATE-01 Add a "Payment hold" state (prepared repo) | 3/3 | 27/27 | 36 | 112 s | $0.78 | 6 |
| T-MULTI-01 Change the design-system repo and use it in the app (4 repos) | 3/3 | 27/27 | 60 | 154 s | $1.01 | 7 |

**Total: 11/12 runs passed. Total cost $11.39; median $0.84 per run.**

Baseline with no agent (`--dry`, `stagecraft init` only): 0/4 tasks pass. See `baseline-init-only-no-agent/`.

## Failures

- **T-SET-01, run 2:** the user asked for an "employee"; the agent labelled the persona *Employee* but kept the `init` template's role `member`, so the app shows "member". Cause: our template anchored the agent. Fix: template personas and states are now marked "(placeholder)", doctor warns while they remain, and the setup skill says to use the user's words. **Not re-run yet.**

## Findings from the transcripts

1. **Screenshots of error states hung in run 1** (4 timeouts in T-MULTI-01). `networkidle` never fires when the app ignores an error body. The agent then blamed its own code ("may be fetching over and over"); I reproduced it and the code was fine. Fixed with `settle()`. Runs 2–3: 0 screenshot errors, with faults injected.
2. **Agents could not open UI behind a click** (run 1: tried `curl` on the chat stream 4×, denied). `actions` added; used in 6 of 8 runs after.
3. **The handler API was undocumented**: in run 1 T-SET-02 the agent read Stagecraft's source to learn `ctx`/`reply`. Now in the setup skill.
4. **No product code changed in setup tasks**: all changes were under Stagecraft paths (FR-106).
5. **Multi-repo works as designed in 3/3**: the component went into the library repo, the app imported it, both repos on one `proto/*` branch, the API repo untouched, and the agent listed the missing `category` field as backend work.
6. **Permission denials are common** (2–7 per run): mostly shell commands outside the allowlist (`curl`, `node -e`, `cd ..`). None blocked a pass, but each costs turns.

