import { defineStates } from '@stagecraft/core';

const manyProjects = Array.from({ length: 12 }, (_, i) => ({
  id: `prx${i + 1}`,
  name: `Project ${i + 1} — ${['Launch', 'Research', 'Rebrand', 'Migration'][i % 4]}`,
  lead: i % 2 ? 'Milo Meyer' : 'Olivia Ortiz',
  health: ['on_track', 'at_risk', 'off_track'][i % 3]!,
  due: `2027-0${(i % 9) + 1}-15`,
}));

export const states = defineStates({
  workspace: {
    label: 'Workspace',
    default: 'active',
    states: {
      active: { label: 'Active', db: { 'workspace.status': 'active' } },
      trial_expired: { label: 'Trial expired', description: 'The free trial ended; billing is needed', db: { 'workspace.status': 'trial_expired', 'workspace.plan': 'Trial' } },
      read_only: { label: 'Read-only', description: 'An admin locked the workspace', db: { 'workspace.status': 'read_only' } },
    },
  },
  projects: {
    label: 'Projects',
    default: 'some',
    states: {
      none: { label: 'None', db: { projects: { $set: [] } } },
      some: { label: 'Two', db: {} },
      many: { label: '12 projects', db: { projects: { $set: manyProjects } } },
    },
  },
});
