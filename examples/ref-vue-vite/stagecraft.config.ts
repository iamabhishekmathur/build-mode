import { defineConfig } from '@stagecraft/core';
import { seed, type DB } from './stagecraft/seed';
import { handlers } from './stagecraft/mocks';
import { states } from './stagecraft/states';

export default defineConfig<DB>({
  devCommand: 'npm run dev',
  devUrl: 'http://localhost:5175',
  port: 4430,
  apiOrigins: ['/api', 'https://api.fieldnote.example'],
  handlers,
  seed,
  personas: {
    owner: { label: 'Owner (Olivia)', userId: 'u1', role: 'owner' },
    member: { label: 'Member (Milo)', userId: 'u2', role: 'member' },
  },
  defaultPersona: 'owner',
  states,
  flags: {
    'project-health': { default: false, description: 'Show a health pill on each project' },
  },
});
