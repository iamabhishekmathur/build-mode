---
name: self-check
description: Look at your own UI changes in screenshots across states before you tell the user you are done.
---

# Self-check

Reading code misses visual bugs. Look at the screen.

1. List the routes you changed.
2. For each route, pick the states that matter: default, empty, error, each product state that changes the screen, and each persona that sees it differently. Include at least one narrow viewport (`width: 375`).
3. For each combination: set it with `scenario_load` or `state_set` / `persona_set`, then `preview_screenshot`.
4. Look for: overlap, cut-off or wrapped text, wrong empty state, broken alignment, missing icons, low contrast, dark-mode issues, scrollbars where none should be, placeholder text left in.
5. Fix every problem you find, then screenshot again.
6. In your reply, list the states you checked.
