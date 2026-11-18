import { defineConfig, defineFlags } from '@stagecraft/core';
import { growthbookMocks, ldMocks, mergeVendorMocks, unleashMocks } from '@stagecraft/flags/mocks';

// Flags the panel shows. Each SDK reads the same session values through its own adapter.
const flags = defineFlags({
  'of-new-checkout': { default: false, description: 'OpenFeature: one-page checkout' },
  'ld-banner': { default: 'none', options: ['none', 'sale', 'holiday'], description: 'LaunchDarkly v3 SDK: promo banner' },
  'ld4-compact-header': { default: false, description: 'LaunchDarkly v4 SDK: compact header' },
  'gb-annual-pricing': { default: false, description: 'GrowthBook: annual pricing' },
  'unleash-beta-badge': { default: false, description: 'Unleash: beta features' },
});

// Vendor endpoints answered by Stagecraft. The SDKs keep their real hosts; nothing reaches the vendors.
const vendors = mergeVendorMocks(
  ldMocks({ defs: flags }),
  growthbookMocks(),
  unleashMocks({ url: 'https://unleash.flagship.example/api/frontend' }),
);

export default defineConfig({
  devCommand: 'npm run dev',
  devUrl: 'http://localhost:5175',
  port: 4410,
  apiOrigins: ['/api', ...vendors.apiOrigins],
  handlers: { ...vendors.handlers },
  seed: {},
  personas: { visitor: { label: 'Visitor' } },
  defaultPersona: 'visitor',
  flags,
});
