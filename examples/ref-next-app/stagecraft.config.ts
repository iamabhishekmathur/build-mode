import { defineConfig } from '@stagecraft/core';
import { seed, type DB } from './stagecraft/seed';
import { handlers } from './stagecraft/mocks';
import { states } from './stagecraft/states';

export default defineConfig<DB>({
  devCommand: 'npm run dev',
  devUrl: 'http://localhost:3100',
  port: 4410,
  apiOrigins: ['https://api.acme-billing.example'],
  handlers,
  seed,
  personas: {
    owner: { label: 'Owner (Olu)', userId: 'u1', role: 'owner' },
    viewer: { label: 'Viewer (Vic)', userId: 'u2', role: 'viewer' },
  },
  defaultPersona: 'owner',
  states,
});
