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
  invoices: {
    label: 'Invoices',
    default: 'some',
    states: {
      none: { label: 'None', db: { invoices: { $set: [] } } },
      some: { label: 'Two', db: {} },
      overdue: { label: 'One overdue', db: { 'invoices[id=in1].status': 'overdue' } },
    },
  },
});
