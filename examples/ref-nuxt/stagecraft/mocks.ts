import { defineHandlers } from '@stagecraft/core';
import type { DB } from './seed';

export const handlers = defineHandlers<DB>({
  'GET /v1/me': ({ db, persona }) => db.users.find((u) => u.id === persona.userId),
  'GET /v1/account': ({ db }) => db.account,
  'GET /v1/tickets': ({ db }) => db.tickets,
  'POST /v1/tickets/:id/close': ({ db, params, reply }) => {
    if (db.account.status === 'suspended') return reply(423, { error: 'The account is suspended' });
    const t = db.tickets.find((x) => x.id === params.id);
    if (!t) return reply(404, { error: 'No such ticket' });
    t.status = 'closed';
    return t;
  },
});
