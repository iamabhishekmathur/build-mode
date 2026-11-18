import { defineHandlers } from '@stagecraft/core';
import type { DB } from './seed';

// One set of mocks serves both apps (dashboard and admin): they share the mock DB.
export const handlers = defineHandlers<DB>({
  'GET /v1/me': ({ db, persona }) => db.users.find((u) => u.id === persona.userId),
  'GET /v1/account': ({ db }) => db.account,
  'POST /v1/account/unfreeze': ({ db, persona, reply }) => {
    if (persona.role !== 'support') return reply(403, { error: 'Only support can unfreeze accounts' });
    db.account.status = 'active';
    return db.account;
  },
  'GET /v1/payments': ({ db }) => db.payments,
});
