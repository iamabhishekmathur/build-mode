import { defineConfig } from '@stagecraft/core';
import { seed, type DB } from './stagecraft/seed';
import { handlers } from './stagecraft/mocks';
import { states } from './stagecraft/states';

export default defineConfig<DB>({
  devCommand: 'npm run dev',
  devUrl: 'http://localhost:3130',
  port: 4440,
  apiOrigins: ['https://api.orbit-support.example'],
  handlers,
  seed,
  personas: {
    admin: { label: 'Admin (Ines)', userId: 'u1', role: 'admin' },
    agent: { label: 'Agent (Theo)', userId: 'u2', role: 'agent' },
  },
  defaultPersona: 'admin',
  states,
  flags: {
    'priority-badges': { default: false, description: 'Show a priority badge on each ticket' },
  },
});
