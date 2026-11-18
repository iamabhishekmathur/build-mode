---
name: add-state
description: Add a product state (frozen account, over limit, pending approval…) to the state catalog so anyone can switch to it in the panel.
---

# Add a state

1. Find the field in the API types that drives the state (an enum, a status, a count, a date).
2. In `stagecraft/states.ts`, add the state under its entity:
   ```ts
   account: {
     label: 'Account', default: 'active',
     states: {
       frozen: { label: 'Frozen', db: { 'account.status': 'frozen', 'account.frozenReason': 'Unusual activity' } },
     },
   },
   ```
   - `db` is a patch on the mock DB. Paths: `account.status`, `users[id=u2].role`, `payments[0].amount`. Ops: `{ $push: x }`, `{ $merge: {...} }`, `{ $remove: true }`, `{ $inc: 1 }`.
   - Add `flags` if the state also forces a flag.
3. Make sure the UI reads that field. If the screen ignores it, that is a product gap: tell the user.
4. `state_set` the new state, then `preview_screenshot` the screen. Confirm the screen changed where you expected.
5. Save a scenario with `scenario_save` so others can open it.
