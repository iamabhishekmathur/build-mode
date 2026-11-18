import type { DbPatch, Json } from './types.ts';

export const TAPE_VERSION = 1;

export interface Cond {
  path: string;
  equals?: Json;
  in?: Json[];
  exists?: boolean;
}

interface Base {
  /** Short label shown in the panel timeline. */
  label?: string;
}

export type TapeEvent = Base &
  (
    | { type: 'user_message'; text: string }
    | {
        type: 'agent_message';
        text: string;
        id?: string;
        /** Delay between streamed chunks. Default 30 ms. */
        tokenDelayMs?: number;
        /** Characters per chunk. Default 4. */
        chunkSize?: number;
        /** Stop streaming after this many characters (partial stream). */
        cutAt?: number;
      }
    | { type: 'tool_call'; id: string; name: string; input?: Json }
    | { type: 'tool_result'; id: string; output?: Json; isError?: boolean }
    | {
        type: 'pending_action';
        id: string;
        kind: string;
        title: string;
        data?: Json;
        actions?: string[];
      }
    | { type: 'state_change'; patch: DbPatch }
    | { type: 'delay'; ms: number }
    | { type: 'error'; message: string; code?: string }
    | { type: 'timeout'; afterMs: number }
    | {
        type: 'branch';
        /** Wait for a mock DB condition (set by the viewer's action in the real UI). */
        cases: { when: Cond; goto: string; label?: string }[];
        /** Segment to take if nothing matches within `timeoutMs`. */
        default?: string;
        timeoutMs?: number;
      }
  );

export type TapeEventType = TapeEvent['type'];

export const TAPE_EVENT_TYPES: TapeEventType[] = [
  'user_message',
  'agent_message',
  'tool_call',
  'tool_result',
  'pending_action',
  'state_change',
  'delay',
  'error',
  'timeout',
  'branch',
];

export interface Tape {
  $schema?: string;
  version: 1;
  id: string;
  title: string;
  description?: string;
  /** Scenario to load before the tape starts. */
  scenario?: string;
  events: TapeEvent[];
  branches?: Record<string, TapeEvent[]>;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

const REQUIRED: Record<TapeEventType, [string, string][]> = {
  user_message: [['text', 'string']],
  agent_message: [['text', 'string']],
  tool_call: [['id', 'string'], ['name', 'string']],
  tool_result: [['id', 'string']],
  pending_action: [['id', 'string'], ['kind', 'string'], ['title', 'string']],
  state_change: [['patch', 'object']],
  delay: [['ms', 'number']],
  error: [['message', 'string']],
  timeout: [['afterMs', 'number']],
  branch: [['cases', 'array']],
};

function typeOf(v: unknown) {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}

/** Validate a tape. Returns an empty list when the tape is valid. */
export function validateTape(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (typeOf(input) !== 'object') return [{ path: '$', message: 'Tape must be a JSON object' }];
  const t = input as Record<string, unknown>;
  if (t.version !== TAPE_VERSION) add('$.version', `Unsupported version ${JSON.stringify(t.version)}. Use ${TAPE_VERSION}.`);
  if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-_]*$/i.test(t.id)) add('$.id', 'id must be a slug (letters, digits, - and _)');
  if (typeof t.title !== 'string' || !t.title) add('$.title', 'title is required');
  if (!Array.isArray(t.events)) add('$.events', 'events must be an array');
  const branches = (t.branches ?? {}) as Record<string, unknown>;
  if (typeOf(branches) !== 'object') add('$.branches', 'branches must be an object of event arrays');

  const segments: [string, unknown][] = [['events', t.events], ...Object.entries(branches).map(([k, v]) => [`branches.${k}`, v] as [string, unknown])];
  const toolCalls = new Set<string>();
  for (const [segPath, events] of segments) {
    if (!Array.isArray(events)) {
      if (segPath !== 'events') add(`$.${segPath}`, 'branch must be an array of events');
      continue;
    }
    events.forEach((ev, i) => {
      const p = `$.${segPath}[${i}]`;
      if (typeOf(ev) !== 'object') return add(p, 'event must be an object');
      const e = ev as Record<string, unknown>;
      if (!TAPE_EVENT_TYPES.includes(e.type as TapeEventType)) {
        return add(`${p}.type`, `Unknown event type ${JSON.stringify(e.type)}. Allowed: ${TAPE_EVENT_TYPES.join(', ')}`);
      }
      for (const [field, kind] of REQUIRED[e.type as TapeEventType]) {
        if (typeOf(e[field]) !== kind) add(`${p}.${field}`, `${e.type} needs "${field}" (${kind})`);
      }
      if (e.type === 'tool_call' && typeof e.id === 'string') toolCalls.add(e.id);
      if (e.type === 'tool_result' && typeof e.id === 'string' && !toolCalls.has(e.id)) {
        add(`${p}.id`, `tool_result "${e.id}" has no earlier tool_call with the same id`);
      }
      if ((e.type === 'delay' && (e.ms as number) < 0) || (e.type === 'timeout' && (e.afterMs as number) < 0)) {
        add(p, 'durations must be ≥ 0');
      }
      if (e.type === 'branch' && Array.isArray(e.cases)) {
        if (i !== events.length - 1) add(p, 'branch must be the last event of its segment');
        (e.cases as unknown[]).forEach((c, ci) => {
          const cc = c as Record<string, unknown>;
          if (typeOf(cc) !== 'object' || typeOf(cc.when) !== 'object' || typeof (cc.when as Cond).path !== 'string') {
            add(`${p}.cases[${ci}]`, 'case needs when.path');
          }
          if (typeof cc.goto !== 'string' || !(cc.goto in branches)) {
            add(`${p}.cases[${ci}].goto`, `goto "${String(cc.goto)}" is not a key in branches`);
          }
        });
        if (e.default !== undefined && !(String(e.default) in branches)) add(`${p}.default`, `default "${String(e.default)}" is not a key in branches`);
      }
    });
  }
  return issues;
}

export function assertTape(input: unknown): Tape {
  const issues = validateTape(input);
  if (issues.length) {
    throw new Error('Invalid tape:\n' + issues.map((i) => `  ${i.path}: ${i.message}`).join('\n'));
  }
  return input as Tape;
}

/** A position in a tape. `index` = number of events already done in `segment`. */
export interface Position {
  segment: string;
  index: number;
}

export function parsePosition(at: string | number | undefined): Position {
  if (at === undefined || at === '') return { segment: 'main', index: 0 };
  const s = String(at);
  const m = /^(?:([a-z0-9-_]+):)?(\d+)$/i.exec(s);
  if (!m) throw new Error(`Bad tape position "${s}". Use "4" or "branchName:2".`);
  return { segment: m[1] ?? 'main', index: Number(m[2]) };
}

export function formatPosition(p: Position): string {
  return p.segment === 'main' ? String(p.index) : `${p.segment}:${p.index}`;
}

export function segmentEvents(tape: Tape, segment: string): TapeEvent[] {
  if (segment === 'main') return tape.events;
  const evs = tape.branches?.[segment];
  if (!evs) throw new Error(`Tape "${tape.id}" has no branch "${segment}"`);
  return evs;
}

/** One hop on the way to a segment: which branch event (and case) leads into it. */
export interface Hop {
  segment: string;
  /** Events taken from this segment (inclusive of the branch event). */
  events: TapeEvent[];
  /** Case that leads into the next hop, if any. */
  via?: { when: Cond; goto: string };
}

/** Path from the start of the tape to a position: the events played, in order, plus branch choices taken. */
export function pathTo(tape: Tape, pos: Position): { events: TapeEvent[]; choices: { when: Cond; goto: string }[] } {
  const chain = findChain(tape, 'main', pos.segment, new Set());
  if (!chain) throw new Error(`Branch "${pos.segment}" is not reachable in tape "${tape.id}"`);
  const events: TapeEvent[] = [];
  const choices: { when: Cond; goto: string }[] = [];
  for (const hop of chain) {
    const segEvents = segmentEvents(tape, hop.segment);
    if (hop.via) {
      events.push(...segEvents);
      choices.push(hop.via);
    } else {
      if (pos.index > segEvents.length) throw new Error(`Position ${formatPosition(pos)} is past the end (${segEvents.length} events)`);
      events.push(...segEvents.slice(0, pos.index));
    }
  }
  return { events, choices };
}

function findChain(tape: Tape, from: string, target: string, seen: Set<string>): { segment: string; via?: { when: Cond; goto: string } }[] | null {
  if (from === target) return [{ segment: from }];
  if (seen.has(from)) return null;
  seen.add(from);
  const evs = segmentEvents(tape, from);
  const last = evs[evs.length - 1];
  if (!last || last.type !== 'branch') return null;
  const cases = [...last.cases];
  if (last.default) cases.push({ when: { path: '__never__', exists: true }, goto: last.default });
  for (const c of cases) {
    const rest = findChain(tape, c.goto, target, seen);
    if (rest) return [{ segment: from, via: { when: c.when, goto: c.goto } }, ...rest];
  }
  return null;
}

/** Total steps along the main segment and each branch, for the timeline. */
export function tapeOutline(tape: Tape) {
  const seg = (name: string, evs: TapeEvent[]) => ({
    segment: name,
    steps: evs.map((e, i) => ({ at: formatPosition({ segment: name, index: i + 1 }), type: e.type, label: e.label ?? defaultLabel(e) })),
  });
  return [seg('main', tape.events), ...Object.entries(tape.branches ?? {}).map(([k, v]) => seg(k, v))];
}

export function defaultLabel(e: TapeEvent): string {
  switch (e.type) {
    case 'user_message':
    case 'agent_message':
      return e.text.length > 40 ? e.text.slice(0, 37) + '…' : e.text;
    case 'tool_call':
      return `Tool: ${e.name}`;
    case 'tool_result':
      return e.isError ? 'Tool error' : 'Tool result';
    case 'pending_action':
      return e.title;
    case 'state_change':
      return 'State change';
    case 'delay':
      return `Wait ${e.ms} ms`;
    case 'error':
      return `Error: ${e.message}`;
    case 'timeout':
      return `Timeout after ${e.afterMs} ms`;
    case 'branch':
      return `Branch: ${e.cases.map((c) => c.goto).join(' / ')}`;
  }
}
