import { defineConfig } from '@stagecraft/core';
import { seed, type DB } from './stagecraft/seed';
import { handlers } from './stagecraft/mocks';
import { states } from './stagecraft/states';

export default defineConfig<DB>({
  devCommand: 'npm run dev',
  devUrl: 'http://localhost:5174',
  port: 4400,
  apiOrigins: ['/api', 'https://api.ledgerly.example'],
  handlers,
  seed,
  personas: {
    admin: { label: 'Admin (Ada)', userId: 'u1', role: 'admin' },
    employee: { label: 'Employee (Eli)', userId: 'u2', role: 'employee' },
    bookkeeper: { label: 'Bookkeeper (Bo)', userId: 'u3', role: 'bookkeeper' },
  },
  defaultPersona: 'admin',
  states,
  flags: {
    'new-nav': { default: false, description: 'Sidebar navigation instead of the top bar' },
    'limit-display': { default: 'bar', options: ['bar', 'text'], description: 'How the monthly limit is shown' },
  },
  tapes: { endpoint: 'GET /api/assistant/stream' },
});
