import { defineStates } from '@stagecraft/core';

export const states = defineStates({
  account: {
    label: 'Account',
    default: 'active',
    states: {
      active: { label: 'Active', db: { 'account.status': 'active' } },
      frozen: { label: 'Frozen', db: { 'account.status': 'frozen' } },
      review: { label: 'In review', db: { 'account.status': 'review' } },
    },
  },
});
