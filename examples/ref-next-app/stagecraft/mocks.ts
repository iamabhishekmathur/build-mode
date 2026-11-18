import { defineHandlers } from '@stagecraft/core';
import type { DB } from './seed';

export const handlers = defineHandlers<DB>({
  'GET /v1/me': ({ db, persona }) => db.users.find((u) => u.id === persona.userId),
  'GET /v1/account': ({ db }) => db.account,
  'GET /v1/invoices': ({ db }) => db.invoices,
  'POST /v1/invoices/:id/pay': ({ db, params, persona, reply }) => {
    if (persona.role !== 'owner') return reply(403, { error: 'Only owners can mark invoices paid' });
    const inv = db.invoices.find((i) => i.id === params.id);
    if (!inv) return reply(404, { error: 'No such invoice' });
    inv.status = 'paid';
    return inv;
  },
});
