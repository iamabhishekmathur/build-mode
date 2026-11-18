---
name: make-tape
description: Write a tape — a scripted conversation of the product's own AI assistant (messages, tool calls, approvals, errors, timeouts) that plays inside the real UI.
---

# Make a tape

A tape plays back the product's in-app assistant with no live model. The viewer can act in the real UI (approve, reject) and the tape follows a branch.

1. Call `state_catalog` and `mock_endpoints`. Find the tape endpoint and the mock DB fields the conversation touches.
2. Write the tape JSON:
   ```json
   {
     "version": 1, "id": "vendor-payment-approval", "title": "Vendor payment needs approval",
     "events": [
       { "type": "user_message", "text": "Pay Acme $4,200" },
       { "type": "agent_message", "text": "I'll prepare that payment." },
       { "type": "tool_call", "id": "t1", "name": "create_payment", "input": { "vendor": "Acme", "amount": 4200 } },
       { "type": "timeout", "afterMs": 3000, "label": "First try times out" },
       { "type": "tool_result", "id": "t1", "output": { "paymentId": "p9", "status": "pending_approval" } },
       { "type": "state_change", "patch": { "payments": { "$push": { "id": "p9", "vendor": "Acme", "amount": 4200, "status": "pending_approval" } } } },
       { "type": "pending_action", "id": "a1", "kind": "approve_payment", "title": "Approve $4,200 to Acme?", "data": { "paymentId": "p9" } },
       { "type": "branch", "cases": [
         { "when": { "path": "payments[id=p9].status", "equals": "approved" }, "goto": "approved" },
         { "when": { "path": "payments[id=p9].status", "equals": "rejected" }, "goto": "rejected" }
       ] }
     ],
     "branches": {
       "approved": [{ "type": "agent_message", "text": "Done. Acme will be paid today." }],
       "rejected": [{ "type": "agent_message", "text": "OK, I cancelled it." }]
     }
   }
   ```
   - `branch` waits until the mock DB matches a case. The viewer's click in the real UI (which calls a mocked endpoint) makes it match.
   - `timeout` stalls the stream, then closes it. The product's retry reconnects and the tape continues.
   - `agent_message` supports `tokenDelayMs`, `chunkSize`, and `cutAt` (partial stream).
   - `error` sends an error event. `delay` waits.
3. `tape_validate`, then `tape_create`.
4. `tape_play` with the id. Screenshot key steps: `tape_play` with `at` (for example `"6"` or `"approved:1"`) pauses there.
5. Give the user a deep link: `/?sc_tape=<id>&sc_step=<at>`.
