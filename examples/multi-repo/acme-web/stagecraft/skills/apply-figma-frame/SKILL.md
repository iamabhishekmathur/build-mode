---
name: apply-figma-frame
description: Build a screen from a Figma frame link using real code components (Code Connect) and design tokens.
---

# Apply a Figma frame

Needs the Figma MCP server. If it is not connected, tell the user how to add it (`https://mcp.figma.com/mcp`) and stop.

1. Get design context for the frame link. Get the Code Connect map if the file has one.
2. Map each Figma component to a code component. Prefer Code Connect mappings, then the design-system package, then similar components in the repo. Never copy generated markup as-is.
3. Map Figma variables to code tokens: get the variables from the Figma MCP (`get_variable_defs`) and pass them to `tokens_map`. For any variable with no token, do not hard-code the value: list it for the person (it is design-system work).
4. Build with the `build-screen` skill.
5. Save the frame as a PNG at 1x (Figma MCP screenshot) in `.stagecraft-cache/`, then run `check_figma` with it and the route. It returns a score, the regions that differ, and reference/actual/diff images. Judge real differences (layout, spacing, type, color, components) from the images; ignore anti-aliasing and placeholder content. Fix them, run it again, and report the final score.
6. If the Figma call is rate-limited, say so and wait; do not guess the design.
