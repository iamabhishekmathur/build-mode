import type { DbMode, FlagDef, Json, PersonaDef, StateCatalog } from './types.ts';

/** Request context given to a mock handler. */
export interface MockContext<DB = any> {
  /** The live mock DB for this session. Mutate it to persist writes. */
  db: DB;
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  path: string;
  persona: PersonaDef & { id: string };
  flags: Record<string, Json>;
  states: Record<string, string>;
  /** Build a response with a status code. */
  reply: (status: number, body?: unknown, headers?: Record<string, string>) => MockReply;
}

export interface MockReply {
  __stagecraftReply: true;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type MockHandler<DB = any> = (ctx: MockContext<DB>) => unknown | Promise<unknown>;

export interface TapeTransportConfig {
  /** Endpoint the product's chat UI opens, e.g. `GET /api/assistant/stream`. */
  endpoint: string;
  /** `sse` (default) or `websocket`. */
  transport?: 'sse' | 'websocket';
}

export interface StagecraftConfig<DB = any> {
  /** Command that starts the app's dev server. */
  devCommand?: string;
  /** URL where the dev server listens. */
  devUrl: string;
  /** Port for the Stagecraft proxy. Default 4400. */
  port?: number;
  /** API origins to intercept. A path (`/api`) or a full origin (`https://api.example.com`). */
  apiOrigins: string[];
  /** Mock handlers keyed by `METHOD /path/:param`. Use `*` for any method. */
  handlers: Record<string, MockHandler<DB>>;
  /** Initial mock DB. */
  seed: DB | (() => DB);
  personas: Record<string, PersonaDef>;
  defaultPersona: string;
  states?: StateCatalog;
  flags?: Record<string, FlagDef>;
  /** Folder for scenario JSON files. Default `stagecraft/scenarios`. */
  scenariosDir?: string;
  /** Folder for tape JSON files. Default `stagecraft/tapes`. */
  tapesDir?: string;
  tapes?: TapeTransportConfig;
  /** `session` (default): each session has its own DB. `shared`: one DB for everyone. */
  dbMode?: DbMode;
  /** What to do with requests to API origins that have no handler. Default `404`. */
  unmocked?: 'error' | '404';
}

/** Identity helpers for typed config files. */
export const defineConfig = <DB>(c: StagecraftConfig<DB>) => c;
export const defineStates = (s: StateCatalog) => s;
export const definePersonas = <T extends Record<string, PersonaDef>>(p: T) => p;
export const defineFlags = <T extends Record<string, FlagDef>>(f: T) => f;
export const defineHandlers = <DB>(h: Record<string, MockHandler<DB>>) => h;
