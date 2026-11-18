import type { DbPatch, Scenario } from './types.ts';

export interface ValidationIssueLite {
  path: string;
  message: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9 _\-–]*$/i;

export function validateScenario(input: unknown): ValidationIssueLite[] {
  const out: ValidationIssueLite[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [{ path: '$', message: 'Scenario must be an object' }];
  const s = input as Record<string, unknown>;
  if (typeof s.name !== 'string' || !NAME_RE.test(s.name)) out.push({ path: '$.name', message: 'name is required (letters, digits, spaces, - and _)' });
  for (const k of ['states', 'flags', 'variants', 'db'] as const) {
    if (s[k] !== undefined && (typeof s[k] !== 'object' || s[k] === null || Array.isArray(s[k]))) out.push({ path: `$.${k}`, message: `${k} must be an object` });
  }
  if (s.faults !== undefined && !Array.isArray(s.faults)) out.push({ path: '$.faults', message: 'faults must be an array' });
  for (const k of ['persona', 'extends', 'url', 'description'] as const) {
    if (s[k] !== undefined && typeof s[k] !== 'string') out.push({ path: `$.${k}`, message: `${k} must be a string` });
  }
  return out;
}

/** Slug used for the scenario file name. */
export function scenarioSlug(name: string) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Resolve `extends` chains. Child fields override base fields; maps merge; db patches stack. */
export function resolveScenario(name: string, all: Record<string, Scenario>, seen: string[] = []): Scenario & { dbPatches: DbPatch[] } {
  const s = all[name] ?? Object.values(all).find((x) => scenarioSlug(x.name) === scenarioSlug(name));
  if (!s) throw new Error(`Scenario "${name}" not found`);
  if (seen.includes(s.name)) throw new Error(`Scenario extends cycle: ${[...seen, s.name].join(' → ')}`);
  if (!s.extends) return { ...s, dbPatches: s.db ? [s.db] : [] };
  const base = resolveScenario(s.extends, all, [...seen, s.name]);
  return {
    ...base,
    ...s,
    states: { ...base.states, ...s.states },
    flags: { ...base.flags, ...s.flags },
    variants: { ...base.variants, ...s.variants },
    faults: s.faults ?? base.faults,
    dbSnapshot: s.dbSnapshot ?? base.dbSnapshot,
    dbPatches: [...base.dbPatches, ...(s.db ? [s.db] : [])],
  };
}
