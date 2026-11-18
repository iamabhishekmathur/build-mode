/** JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * A DB patch maps a path to an operation.
 * Path syntax: `account.status`, `users[id=u2].onboardingStep`, `payments[0].amount`.
 * A plain value means "set". Objects with one `$` key are operations.
 */
export type PatchOp =
  | { $set: Json }
  | { $merge: JsonObject }
  | { $push: Json }
  | { $remove: true }
  | { $inc: number };
export type DbPatch = Record<string, Json | PatchOp>;

export interface PersonaDef {
  label: string;
  description?: string;
  /** Id of the user record in the mock DB that this persona logs in as. */
  userId?: string;
  role?: string;
  [extra: string]: unknown;
}

export interface StateDef {
  label?: string;
  description?: string;
  /** Mock DB patch applied when this state is selected. */
  db?: DbPatch;
  /** Flag values forced while this state is selected. */
  flags?: Record<string, Json>;
}

export interface EntityStates {
  label?: string;
  /** State selected on a fresh session. */
  default: string;
  states: Record<string, StateDef>;
}

export type StateCatalog = Record<string, EntityStates>;

export interface FlagDef {
  default: Json;
  description?: string;
  /** Allowed values. Booleans need none. */
  options?: Json[];
}

export interface FaultRule {
  /** Endpoint pattern, e.g. `GET /api/payments` or `* /api/payments/:id`. */
  endpoint: string;
  latencyMs?: number;
  status?: number;
  /** Hold the request open and never answer (client sees its own timeout). */
  timeout?: boolean;
  body?: Json;
}

export interface TapeRef {
  id: string;
  /** Position string: `4` (main segment) or `approved:2` (branch segment). */
  at?: string;
  /** Start playing on load. Default: true when `at` is not set. */
  autoplay?: boolean;
}

/** Everything the panel controls, per session. */
export interface SessionState {
  persona: string;
  states: Record<string, string>;
  flags: Record<string, Json>;
  variants: Record<string, string>;
  faults: FaultRule[];
  scenario?: string;
  tape?: TapeRef;
  /** Fixed "now" for the app and the mocks (ISO time). Time runs forward from it. */
  clock?: string;
  viewport?: { width: number; height: number };
  theme?: 'light' | 'dark';
  locale?: string;
}

export interface Scenario {
  $schema?: string;
  name: string;
  description?: string;
  /** Name of a base scenario. Fields here override the base. */
  extends?: string;
  persona?: string;
  states?: Record<string, string>;
  flags?: Record<string, Json>;
  variants?: Record<string, string>;
  faults?: FaultRule[];
  url?: string;
  /** Fixed "now" (ISO), so dates in the scenario never go stale. */
  clock?: string;
  viewport?: { width: number; height: number };
  theme?: 'light' | 'dark';
  locale?: string;
  /** Extra DB patch on top of seed + states. */
  db?: DbPatch;
  /** Full mock DB snapshot. Wins over seed + states + db when present. */
  dbSnapshot?: Json;
  tape?: TapeRef;
}

export type DbMode = 'session' | 'shared';
