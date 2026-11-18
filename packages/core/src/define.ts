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
  /** "Now" for this session: the scenario clock if set, else the real time. Use it instead of new Date(). */
  now: Date;
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

/** One repo in a multi-repo workspace. Paths are relative to the host repo (the one with this config). */
export interface WorkspaceRepo {
  /** Folder of the checkout, e.g. `../acme-ui`. */
  path: string;
  /** Clone URL. `stagecraft workspace clone` uses it when the folder is missing. */
  git?: string;
  /**
   * `app`: another frontend with its own dev server, served through the same proxy.
   * `library`: a package the apps consume (design system, API client). Linked for dev.
   * `api`: a backend repo. Read-only; its OpenAPI spec checks the mocks.
   */
  role: 'app' | 'library' | 'api' | 'other';
  /** library: npm package name to link, e.g. `@acme/ui`. */
  package?: string;
  /** library: folder inside the repo that holds the package (monorepo libraries). Default: repo root. */
  packagePath?: string;
  /** app: dev server. */
  devCommand?: string;
  devUrl?: string;
  /** app: path prefix on the proxy, e.g. `/admin` (the app must use this base path). */
  mount?: string;
  /** app: or a separate proxy port, for apps that cannot use a base path. */
  port?: number;
  /** api: OpenAPI spec file (JSON or YAML), relative to the repo. */
  openapi?: string;
  /** Prototypes never change this repo (default true for `api`). */
  readOnly?: boolean;
}

export interface WorkspaceConfig {
  repos: Record<string, WorkspaceRepo>;
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
  /** Share links (FR-1401..1405). `publicLinks: false` blocks new links and stops existing ones at once. */
  sharing?: { publicLinks?: boolean; defaultExpiry?: string };
  /** Multi-repo workspace: other repos that make up the product. */
  workspace?: WorkspaceConfig;
  /** What to do with requests to API origins that have no handler. Default `404`. */
  unmocked?: 'error' | '404';
}

/** Identity helpers for typed config files. */
export const defineConfig = <DB>(c: StagecraftConfig<DB>) => c;
export const defineStates = (s: StateCatalog) => s;
export const definePersonas = <T extends Record<string, PersonaDef>>(p: T) => p;
export const defineFlags = <T extends Record<string, FlagDef>>(f: T) => f;
export const defineHandlers = <DB>(h: Record<string, MockHandler<DB>>) => h;
