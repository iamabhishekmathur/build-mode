import { defineConfig } from '@stagecraft/core';
import { seed, type DB } from './stagecraft/seed';
import { handlers } from './stagecraft/mocks';
import { states } from './stagecraft/states';

export default defineConfig<DB>({
  devCommand: 'npm run dev',
  devUrl: 'http://localhost:5191',
  port: 4420,
  apiOrigins: ['https://api.acme.example'],
  handlers,
  seed,
  personas: {
    owner: { label: 'Customer (Cora)', userId: 'u1', role: 'owner' },
    support: { label: 'Support (Sam)', userId: 'u2', role: 'support' },
  },
  defaultPersona: 'owner',
  states,
  workspace: {
    repos: {
      ui: { path: '../acme-ui', role: 'library', package: '@acme/ui', git: 'https://github.com/acme/ui.git' },
      admin: { path: '../acme-admin', role: 'app', devCommand: 'npm run dev', devUrl: 'http://localhost:5192', mount: '/admin' },
      api: { path: '../acme-api', role: 'api', openapi: 'openapi.json' },
    },
  },
});
