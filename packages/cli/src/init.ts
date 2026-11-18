import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect } from '@stagecraft/server';
import { sync, writeMcpConfigs } from './agents.ts';

const CONFIG = (devCommand: string, devPort: number) => `import { defineConfig } from '@stagecraft/core';
import { seed, type DB } from './stagecraft/seed';
import { handlers } from './stagecraft/mocks';
import { states } from './stagecraft/states';

export default defineConfig<DB>({
  devCommand: ${JSON.stringify(devCommand)},
  devUrl: 'http://localhost:${devPort}',
  port: 4400,
  // Requests to these origins never reach a real backend. Add full origins too, e.g. 'https://api.example.com'.
  apiOrigins: ['/api'],
  handlers,
  seed,
  // PLACEHOLDERS: replace with your product's real roles, in your users' words.
  // Doctor warns while "(placeholder)" is in a label.
  personas: {
    admin: { label: 'Admin (placeholder)', userId: 'u1', role: 'admin' },
    member: { label: 'Member (placeholder)', userId: 'u2', role: 'member' },
  },
  defaultPersona: 'admin',
  states,
  flags: {
    // 'new-nav': { default: false, description: 'New navigation' },
  },
});
`;

const SEED = `// Initial mock DB. Fake data only. Never paste production data here.
export const seed = () => ({
  users: [
    { id: 'u1', name: 'Ada Admin', email: 'ada@example.test', role: 'admin' },
    { id: 'u2', name: 'Max Member', email: 'max@example.test', role: 'member' },
  ],
  account: { id: 'acc1', name: 'Example Co', status: 'active' },
});
export type DB = ReturnType<typeof seed>;
`;

const MOCKS = `import { defineHandlers } from '@stagecraft/core';
import type { DB } from './seed';

// Keys are "METHOD /path/:param". Mutate ctx.db to persist writes for the session.
export const handlers = defineHandlers<DB>({
  'GET /api/me': ({ db, persona }) => db.users.find((u) => u.id === persona.userId),
  'GET /api/account': ({ db }) => db.account,
});
`;

const STATES = `import { defineStates } from '@stagecraft/core';

export const states = defineStates({
  account: {
    label: 'Account',
    default: 'active',
    states: {
      active: { label: 'Active (placeholder)', db: { 'account.status': 'active' } },
      frozen: { label: 'Frozen (placeholder)', db: { 'account.status': 'frozen' } },
    },
  },
});
`;

export function init(root: string, log: (m: string) => void) {
  const d = detect(root);
  writeFileSync(join(root, 'stagecraft.detect.json'), JSON.stringify(d, null, 2) + '\n');
  log(`Detected: ${d.framework ? `${d.framework.name} ${d.framework.version ?? ''} (Tier ${d.framework.tier})` : 'no framework'}; dev: ${d.devCommand ?? '?'} on port ${d.devPort ?? '?'}`);
  for (const n of d.notes) log(`  note: ${n}`);
  const files: [string, string][] = [
    ['stagecraft.config.ts', CONFIG(d.devCommand ?? 'npm run dev', d.devPort ?? 5173)],
    ['stagecraft/seed.ts', SEED],
    ['stagecraft/mocks.ts', MOCKS],
    ['stagecraft/states.ts', STATES],
    ['stagecraft/scenarios/.gitkeep', ''],
    ['stagecraft/tapes/.gitkeep', ''],
    ['.env.stagecraft', '# Safe fake values for prototyping. Never put real secrets here.\nSTAGECRAFT=1\n'],
  ];
  for (const [rel, content] of files) {
    const f = join(root, rel);
    if (existsSync(f)) {
      log(`  keep   ${rel}`);
      continue;
    }
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, content);
    log(`  create ${rel}`);
  }
  for (const rel of sync(root)) log(`  sync   ${rel}`);
  for (const rel of writeMcpConfigs(root)) log(`  mcp    ${rel}`);
  const gi = join(root, '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!cur.includes('.stagecraft-cache')) writeFileSync(gi, cur.trimEnd() + (cur ? '\n' : '') + '.stagecraft-cache/\n');
  const adapter = d.framework && ['vue', 'nuxt'].includes(d.framework.name) ? '@stagecraft/vue' : '@stagecraft/react';
  log(`Next: install the packages (npm i -D stagecraft @stagecraft/core ${adapter}), edit stagecraft/*.ts, then run "npx --no stagecraft dev".`);
  return d;
}
