import { defineHandlers } from '@stagecraft/core';
import type { DB } from './seed';

const me = (db: DB, userId?: string) => db.users.find((u) => u.id === userId)!;

export const handlers = defineHandlers<DB>({
  // Same-origin API (/api), served by the proxy.
  'GET /api/me': ({ db, persona }) => me(db, persona.userId),
  'PATCH /api/me': ({ db, persona, body, reply }) => {
    if (db.workspace.status === 'read_only') return reply(423, { error: 'This workspace is read-only' });
    const u = me(db, persona.userId);
    u.statusMessage = String((body as { statusMessage?: unknown })?.statusMessage ?? '').slice(0, 80);
    return u;
  },
  'GET /api/workspace': ({ db }) => db.workspace,
  // Cross-origin API (https://api.fieldnote.example).
  'GET /v1/projects': ({ db }) => db.projects,
  'POST /v1/projects': ({ db, body, persona, reply }) => {
    if (persona.role !== 'owner') return reply(403, { error: 'Only owners can create projects' });
    const name = String((body as { name?: unknown })?.name ?? '').trim();
    if (!name) return reply(400, { error: 'Name is required' });
    const p = { id: `pr${db.projects.length + 1}`, name, lead: me(db, persona.userId).name, health: 'on_track', due: '2027-01-15' };
    db.projects.push(p);
    return p;
  },
});
