import { defineStates } from '@stagecraft/core';

export const states = defineStates({
  account: {
    label: 'Account',
    default: 'active',
    states: {
      active: { label: 'Active', db: { 'account.status': 'active' } },
      past_due: { label: 'Past due', db: { 'account.status': 'past_due' } },
      suspended: { label: 'Suspended', db: { 'account.status': 'suspended' } },
    },
  },
  tickets: {
    label: 'Tickets',
    default: 'some',
    states: {
      none: { label: 'None', db: { tickets: { $set: [] } } },
      some: { label: 'Two', db: {} },
      urgent: { label: 'One urgent', db: { 'tickets[id=t1].priority': 'urgent' } },
    },
  },
});
