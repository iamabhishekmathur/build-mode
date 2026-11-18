---
name: create-variant
description: Show two to four design options of one region side by side, in one branch, with no branch switching.
---

# Create a variant

1. Pick a short kebab-case name for the region, for example `agent-list-layout`.
2. Wrap only the region that changes:
   ```tsx
   import { Variant } from '@stagecraft/react';

   <Variant name="agent-list-layout" options={{
     table: <AgentTable agents={agents} />,
     cards: <AgentCards agents={agents} />,
   }} />
   ```
   Vue / Nuxt: one named slot per option.
   ```vue
   <script setup lang="ts">
   import { Variant } from '@stagecraft/vue';
   </script>
   <template>
     <Variant name="agent-list-layout">
       <template #table><AgentTable :agents="agents" /></template>
       <template #cards><AgentCards :agents="agents" /></template>
     </Variant>
   </template>
   ```
   For logic differences use `const layout = useVariant('agent-list-layout', ['table', 'cards'])` (in Vue it returns a computed ref).
3. Keep shared data loading outside the variant so both options use the same data.
4. Load the page once so the variant registers. Then call `variant_list`.
5. For each option: `variant_select`, then `preview_screenshot`. Check both in the key states.
6. Tell the user the panel has a ⇆ button that shows all options side by side.
