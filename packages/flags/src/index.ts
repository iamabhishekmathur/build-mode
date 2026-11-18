// Browser-safe, dependency-free entry for product code. OpenFeature providers live in
// `@stagecraft/flags/openfeature` (web) and `@stagecraft/flags/openfeature-server` (Node),
// so apps that do not use OpenFeature never import its SDK.
export { changedKeys, isStagecraft, onStagecraftFlags, stagecraftRuntime } from './runtime.ts';
export { syncGrowthBook, syncLaunchDarkly, syncUnleash, type LaunchDarklyLikeClient, type SyncOptions } from './sync.ts';
// Mock handlers are server-side only: import them from `@stagecraft/flags/mocks` in stagecraft.config.ts.
