---
name: apply-figma-frame
description: Build a screen from a Figma frame link using real code components (Code Connect) and design tokens.
---

# Apply a Figma frame

Needs the Figma MCP server. If it is not connected, tell the user how to add it (`https://mcp.figma.com/mcp`) and stop.

1. Get design context for the frame link. Get the Code Connect map if the file has one.
2. Map each Figma component to a code component. Prefer Code Connect mappings, then the design-system package, then similar components in the repo. Never copy generated markup as-is.
3. Map Figma variables to code tokens. List any Figma value with no matching token; do not hard-code it.
4. Build with the `build-screen` skill.
5. Screenshot the result with `preview_screenshot` at the frame's width. Compare it with the Figma frame image: layout, spacing, type, color, components. Fix differences or list them for the user.
6. If the Figma call is rate-limited, say so and wait; do not guess the design.
