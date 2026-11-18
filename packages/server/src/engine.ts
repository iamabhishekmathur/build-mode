import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyPatch,
  assertTape,
  clone,
  getPath,
  resolveScenario,
  scenarioSlug,
  tapeOutline,
  type DbPatch,
  type FaultRule,
  type Json,
  type Scenario,
  type SessionState,
  type Tape,
} from '@stagecraft/core';
import { loadConfig, loadScenarios, loadTapes, writeJson, type LoadedConfig } from './config.ts';
import { compile, type Route } from './routes.ts';
import { TapePlayer, type TapeStatus } from './tape-player.ts';

export type SessionEvent =
  | { type: 'state'; reason: 'data' | 'ui'; state: SessionState; flags: Record<string, Json>; dataVersion: number; uiVersion: number }
  | { type: 'db' }
  | { type: 'navigate'; url: string }
  | { type: 'tape'; status: TapeStatus | null }
  | { type: 'reload' }
  | { type: 'feedback' };

export interface Session {
  id: string;
  state: SessionState;
  dbRef: { db: Json };
  dataVersion: number;
  uiVersion: number;
  listeners: Set<(e: SessionEvent) => void>;
  dbListeners: Set<() => void>;
  player: TapePlayer | null;
  createdAt: number;
  lastSeen: number;
}

export interface PatchInput {
  persona?: string;
  states?: Record<string, string>;
  flags?: Record<string, Json | null>;
  variants?: Record<string, string | null>;
  faults?: FaultRule[];
  theme?: 'light' | 'dark';
  locale?: string;
  viewport?: { width: number; height: number };
  /** ISO time, or null for real time. */
  clock?: string | null;
}

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface EngineOptions {
  log?: (msg: string) => void;
  /** Speed factor for tape timing (tests). */
  tapeSpeed?: number;
}

export class Engine {
  loaded!: LoadedConfig;
  routes: Route<LoadedConfig['config']['handlers'][string]>[] = [];
  scenarios: Record<string, Scenario> = {};
  tapes: Record<string, Tape> = {};
  sessions = new Map<string, Session>();
  /** Variants the runtime has seen in the page: name → options. */
  variantsSeen = new Map<string, string[]>();
  /** Requests to API origins with no handler: "GET /api/x" → count. */
  unmocked = new Map<string, number>();
  private sharedDb: { db: Json } | null = null;
  private forkCounter = 0;
  log: (m: string) => void;
  tapeSpeed: number;
  private configFile: string;

  constructor(configFile: string, opts: EngineOptions = {}) {
    this.configFile = configFile;
    this.log = opts.log ?? ((m) => console.log(`[stagecraft] ${m}`));
    this.tapeSpeed = opts.tapeSpeed ?? 1;
  }

  get config() {
    return this.loaded.config;
  }

  get root() {
    return this.loaded.root;
  }

  async init() {
    await this.reload();
    return this;
  }

  /** Reload config, handlers, scenarios and tapes. Sessions keep their DB. */
  async reload() {
    this.loaded = await loadConfig(this.configFile);
    this.routes = Object.entries(this.config.handlers).map(([k, v]) => compile(k, v));
    this.reloadFiles();
  }

  reloadFiles() {
    this.scenarios = loadScenarios(this.scenariosDir, this.log);
    this.tapes = loadTapes(this.tapesDir, this.log);
  }

  get scenariosDir() {
    return resolve(this.root, this.config.scenariosDir);
  }

  get tapesDir() {
    return resolve(this.root, this.config.tapesDir);
  }

  seed(): Json {
    const s = this.config.seed;
    return clone(typeof s === 'function' ? (s as () => Json)() : (s as Json));
  }

  defaultState(): SessionState {
    const states: Record<string, string> = {};
    for (const [entity, def] of Object.entries(this.config.states ?? {})) states[entity] = def.default;
    return { persona: this.config.defaultPersona, states, flags: {}, variants: {}, faults: [] };
  }

  /** Seed + the DB patch of every selected state. */
  freshDb(states: Record<string, string>, extra: DbPatch[] = []): Json {
    const db = this.seed();
    for (const [entity, name] of Object.entries(states)) {
      const patch = this.config.states?.[entity]?.states[name]?.db;
      if (patch) applyPatch(db, patch);
    }
    for (const p of extra) applyPatch(db, p);
    return db;
  }

  getSession(id = 'main'): Session {
    let s = this.sessions.get(id);
    if (!s) {
      const state = this.defaultState();
      let dbRef: { db: Json };
      if (this.config.dbMode === 'shared') {
        this.sharedDb ??= { db: this.freshDb(state.states) };
        dbRef = this.sharedDb;
      } else dbRef = { db: this.freshDb(state.states) };
      s = { id, state, dbRef, dataVersion: 1, uiVersion: 1, listeners: new Set(), dbListeners: new Set(), player: null, createdAt: Date.now(), lastSeen: Date.now() };
      this.sessions.set(id, s);
    }
    s.lastSeen = Date.now();
    return s;
  }

  hasSession(id: string) {
    return this.sessions.has(id);
  }

  /** Copy-on-write fork: a new session with a copy of the base session's state and DB. */
  fork(baseId = 'main'): Session {
    const base = this.getSession(baseId);
    const id = `f${Date.now().toString(36)}${(++this.forkCounter).toString(36)}`;
    const s = this.getSession(id);
    s.state = clone(base.state);
    if (this.config.dbMode !== 'shared') s.dbRef = { db: clone(base.dbRef.db) };
    return s;
  }

  effectiveFlags(s: Session): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const [k, def] of Object.entries(this.config.flags ?? {})) out[k] = def.default;
    for (const [entity, name] of Object.entries(s.state.states)) {
      Object.assign(out, this.config.states?.[entity]?.states[name]?.flags ?? {});
    }
    return Object.assign(out, s.state.flags);
  }

  emit(s: Session, e: SessionEvent) {
    for (const l of s.listeners) l(e);
  }

  private emitState(s: Session, reason: 'data' | 'ui') {
    if (reason === 'data') s.dataVersion++;
    else s.uiVersion++;
    this.emit(s, { type: 'state', reason, state: s.state, flags: this.effectiveFlags(s), dataVersion: s.dataVersion, uiVersion: s.uiVersion });
  }

  dbChanged(s: Session) {
    for (const l of s.dbListeners) l();
    this.emit(s, { type: 'db' });
  }

  /** Apply panel / MCP changes. Re-selecting the current state is a no-op, so reloads keep mock DB writes. */
  patch(s: Session, input: PatchInput): { changed: boolean } {
    let data = false;
    let ui = false;
    if (input.persona !== undefined && input.persona !== s.state.persona) {
      if (!this.config.personas[input.persona]) throw new UserError(`Unknown persona "${input.persona}". Known: ${Object.keys(this.config.personas).join(', ')}`);
      s.state.persona = input.persona;
      data = true;
    }
    for (const [entity, name] of Object.entries(input.states ?? {})) {
      const def = this.config.states?.[entity];
      if (!def) throw new UserError(`Unknown entity "${entity}". Known: ${Object.keys(this.config.states ?? {}).join(', ')}`);
      const st = def.states[name];
      if (!st) throw new UserError(`Unknown state "${name}" for ${entity}. Known: ${Object.keys(def.states).join(', ')}`);
      if (s.state.states[entity] === name) continue;
      s.state.states[entity] = name;
      if (st.db) applyPatch(s.dbRef.db, st.db);
      data = true;
    }
    for (const [k, v] of Object.entries(input.flags ?? {})) {
      const def = this.config.flags?.[k];
      if (!def) throw new UserError(`Unknown flag "${k}". Known: ${Object.keys(this.config.flags ?? {}).join(', ')}`);
      if (v !== null && def.options && !def.options.some((o) => JSON.stringify(o) === JSON.stringify(v))) {
        throw new UserError(`Flag "${k}" must be one of ${JSON.stringify(def.options)}`);
      }
      if (v === null) delete s.state.flags[k];
      else s.state.flags[k] = v;
      ui = true;
    }
    for (const [k, v] of Object.entries(input.variants ?? {})) {
      if (v === null) delete s.state.variants[k];
      else {
        const opts = this.variantsSeen.get(k);
        if (opts && !opts.includes(v)) throw new UserError(`Variant "${k}" has no option "${v}". Options: ${opts.join(', ')}`);
        s.state.variants[k] = v;
      }
      ui = true;
    }
    if (input.faults && JSON.stringify(input.faults) !== JSON.stringify(s.state.faults)) {
      // Faults change what the API returns, so the app must refetch: treat as a data change.
      s.state.faults = input.faults;
      data = true;
    }
    if (input.clock !== undefined && (input.clock ?? undefined) !== s.state.clock) {
      if (input.clock !== null && Number.isNaN(Date.parse(input.clock))) throw new UserError(`clock must be an ISO date-time, got "${input.clock}"`);
      if (input.clock === null) delete s.state.clock;
      else s.state.clock = new Date(input.clock).toISOString();
      data = true;
    }
    for (const k of ['theme', 'locale', 'viewport'] as const) {
      if (input[k] !== undefined) {
        (s.state as any)[k] = input[k];
        ui = true;
      }
    }
    if (data) {
      s.state.scenario = undefined;
      this.emitState(s, 'data');
      this.dbChanged(s);
    } else if (ui) this.emitState(s, 'ui');
    return { changed: data || ui };
  }

  resetDb(s: Session) {
    this.stopTape(s);
    s.dbRef.db = this.freshDb(s.state.states);
    this.emitState(s, 'data');
    this.dbChanged(s);
  }

  seedDb(s: Session, input: { patch?: DbPatch; replace?: Json }) {
    if (input.replace !== undefined) s.dbRef.db = clone(input.replace);
    if (input.patch) {
      try {
        applyPatch(s.dbRef.db, input.patch);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
    }
    this.emitState(s, 'data');
    this.dbChanged(s);
  }

  queryDb(s: Session, path?: string): Json | undefined {
    if (!path) return s.dbRef.db;
    try {
      return getPath(s.dbRef.db, path);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }

  // ---------- scenarios ----------

  listScenarios() {
    return Object.values(this.scenarios).map((s) => ({ name: s.name, description: s.description, extends: s.extends, url: s.url, file: `${this.config.scenariosDir}/${scenarioSlug(s.name)}.json` }));
  }

  loadScenario(s: Session, name: string): { url?: string } {
    let r;
    try {
      r = resolveScenario(name, this.scenarios);
    } catch (e) {
      throw new UserError((e as Error).message, 404);
    }
    this.stopTape(s);
    const state = this.defaultState();
    if (r.persona) {
      if (!this.config.personas[r.persona]) throw new UserError(`Scenario "${name}" uses unknown persona "${r.persona}"`);
      state.persona = r.persona;
    }
    for (const [entity, st] of Object.entries(r.states ?? {})) {
      if (!this.config.states?.[entity]?.states[st]) throw new UserError(`Scenario "${name}": unknown state ${entity}=${st} (stale scenario?)`);
      state.states[entity] = st;
    }
    state.flags = { ...(r.flags ?? {}) };
    state.variants = { ...(r.variants ?? {}) };
    state.faults = r.faults ?? [];
    state.theme = r.theme;
    state.locale = r.locale;
    state.viewport = r.viewport;
    if (r.clock) state.clock = new Date(r.clock).toISOString();
    state.scenario = r.name;
    s.state = state;
    try {
      s.dbRef.db = r.dbSnapshot !== undefined ? clone(r.dbSnapshot) : this.freshDb(state.states, r.dbPatches);
    } catch (e) {
      throw new UserError(`Scenario "${name}": ${(e as Error).message}`);
    }
    this.emitState(s, 'data');
    this.dbChanged(s);
    if (r.tape) this.loadTape(s, r.tape.id, r.tape.at, r.tape.autoplay);
    return { url: r.url };
  }

  saveScenario(s: Session, input: { name: string; description?: string; url?: string; extends?: string; includeDb?: boolean }) {
    if (!input.name || !scenarioSlug(input.name)) throw new UserError('Scenario name is required');
    const def = this.defaultState();
    const states: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.state.states)) if (def.states[k] !== v) states[k] = v;
    const sc: Scenario = {
      $schema: 'https://stagecraft.dev/schema/scenario.v1.json',
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.extends ? { extends: input.extends } : {}),
      persona: s.state.persona,
      states,
      flags: s.state.flags,
      variants: s.state.variants,
      ...(s.state.faults.length ? { faults: s.state.faults } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(s.state.viewport ? { viewport: s.state.viewport } : {}),
      ...(s.state.theme ? { theme: s.state.theme } : {}),
      ...(s.state.clock ? { clock: s.state.clock } : {}),
      ...(input.includeDb !== false ? { dbSnapshot: s.dbRef.db } : {}),
    };
    const file = writeJson(this.scenariosDir, input.name, sc);
    this.scenarios[sc.name] = sc;
    s.state.scenario = sc.name;
    return { file, scenario: sc };
  }

  // ---------- tapes ----------

  listTapes() {
    return Object.values(this.tapes).map((t) => ({ id: t.id, title: t.title, description: t.description, outline: tapeOutline(t) }));
  }

  saveTape(raw: unknown) {
    let tape: Tape;
    try {
      tape = assertTape(raw);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    mkdirSync(this.tapesDir, { recursive: true });
    const file = join(this.tapesDir, `${tape.id}.json`);
    writeFileSync(file, JSON.stringify({ $schema: 'https://stagecraft.dev/schema/tape.v1.json', ...tape }, null, 2) + '\n');
    this.tapes[tape.id] = tape;
    return { file };
  }

  loadTape(s: Session, id: string, at?: string, autoplay?: boolean): TapeStatus {
    const tape = this.tapes[id];
    if (!tape) throw new UserError(`Unknown tape "${id}". Known: ${Object.keys(this.tapes).join(', ') || '(none)'}`, 404);
    this.stopTape(s);
    // Tapes start from a known DB (scenario, else seed + selected states), never from leftover writes,
    // so a deep link gives the same result in any session (FR-704).
    if (tape.scenario) this.loadScenario(s, tape.scenario);
    else s.dbRef.db = this.freshDb(s.state.states);
    const player = new TapePlayer(tape, {
      getDb: () => s.dbRef.db,
      setDb: (db) => (s.dbRef.db = db),
      dbChanged: () => this.dbChanged(s),
      onDbChange: (fn) => {
        s.dbListeners.add(fn);
        return () => s.dbListeners.delete(fn);
      },
      status: (st) => this.emit(s, { type: 'tape', status: st }),
    });
    player.speed = this.tapeSpeed;
    s.player = player;
    s.state.tape = { id, at, autoplay };
    try {
      player.seek(at, autoplay ?? at === undefined);
    } catch (e) {
      this.stopTape(s);
      throw new UserError((e as Error).message);
    }
    return player.status();
  }

  stopTape(s: Session) {
    if (s.player) {
      s.player.dispose();
      s.player = null;
      s.state.tape = undefined;
      this.emit(s, { type: 'tape', status: null });
    }
  }

  // ---------- describe ----------

  catalog() {
    const c = this.config;
    return {
      personas: c.personas,
      defaultPersona: c.defaultPersona,
      states: c.states ?? {},
      flags: c.flags ?? {},
      variants: Object.fromEntries(this.variantsSeen),
      scenarios: this.listScenarios(),
      tapes: this.listTapes().map(({ id, title, description, outline }) => ({ id, title, description, outline })),
      endpoints: this.routes.map((r) => r.key),
      apiOrigins: c.apiOrigins,
      tapeEndpoint: c.tapes?.endpoint ?? null,
    };
  }

  sessionInfo(s: Session) {
    return {
      id: s.id,
      state: s.state,
      flags: this.effectiveFlags(s),
      dataVersion: s.dataVersion,
      uiVersion: s.uiVersion,
      tape: s.player?.status() ?? null,
    };
  }

  scenarioExists(name: string) {
    return existsSync(join(this.scenariosDir, `${scenarioSlug(name)}.json`));
  }
}
