import { isIdField, type Json } from '@stagecraft/core';
import type { ApiOp, ApiSource } from './openapi.ts';
import { camel, isPlural, pascal, propsOf, resolve, singular, type Prop, type Shape, type Types } from './model.ts';

export interface Collection {
  key: string;
  /** Normalised base path, params as `{}`: `/v1/invoices`, `/v1/invoices/{}/lines`. */
  base: string;
  typeName: string;
  idField: string;
  idKind: 'int' | 'uuid' | 'string';
  idPrefix: string;
  /** Fields the mock DB adds to the API type (`id` when the type has none, parent foreign key). */
  added: { name: string; ts: string }[];
  parent?: { coll: Collection; fk: string };
  /** Human-text string fields (for the edge presets). */
  textFields: string[];
  props: Prop[];
}

export interface Singleton {
  key: string;
  base: string;
  typeName: string;
  props: Prop[];
}

export interface ListWrapper {
  prop: string;
  meta: Prop[];
}

export interface Paging {
  limit?: string;
  page?: string;
  offset?: string;
  defaultLimit?: number;
}

export type Plan =
  | { kind: 'list'; op: ApiOp; coll: Collection; wrapper?: ListWrapper; filters: string[]; paging: Paging; parentParam?: string }
  | { kind: 'get' | 'update' | 'delete'; op: ApiOp; coll: Collection; param: string; parentParam?: string; wrapProp?: string }
  | { kind: 'create'; op: ApiOp; coll: Collection; parentParam?: string; wrapProp?: string }
  | { kind: 'action'; op: ApiOp; coll: Collection; param: string; parentParam?: string; status?: string; sample?: Json }
  | { kind: 'singleton-get' | 'singleton-update'; op: ApiOp; single: Singleton }
  | { kind: 'singleton-action'; op: ApiOp; single: Singleton; status?: string; sample?: Json }
  | { kind: 'static'; op: ApiOp; shape?: Shape };

export interface ApiPlan {
  types: Types;
  collections: Collection[];
  singletons: Singleton[];
  handlers: Plan[];
}

const isParam = (s: string) => /^\{.+\}$/.test(s);
const paramName = (s: string) => s.slice(1, -1);
const norm = (segs: string[]) => '/' + segs.map((s) => (isParam(s) ? '{}' : s)).join('/');

/** Response is a list: an array of records, or an object with one array-of-records property. */
function listInfo(shape: Shape | undefined, types: Types): { item: Shape; wrapper?: ListWrapper } | null {
  if (!shape) return null;
  const r = resolve(shape, types);
  const isRecord = (s: Shape) => {
    const x = resolve(s, types);
    return x.kind === 'object' || x.kind === 'union';
  };
  if (r.kind === 'array') return isRecord(r.items) ? { item: r.items } : null;
  if (r.kind !== 'object') return null;
  const arrays = r.props.filter((p) => {
    const x = resolve(p.shape, types);
    return x.kind === 'array' && isRecord(x.items);
  });
  if (!arrays.length) return null;
  const pick = arrays.find((p) => /^(data|items|results|records|entries|list|nodes|edges)$/.test(p.name)) ?? (arrays.length === 1 ? arrays[0] : undefined);
  if (!pick) return null;
  const items = resolve(pick.shape, types) as Extract<Shape, { kind: 'array' }>;
  return { item: items.items, wrapper: { prop: pick.name, meta: r.props.filter((p) => p !== pick) } };
}

const sameShape = (a: Shape, b: Shape) => (a.kind === 'ref' && b.kind === 'ref' ? a.name === b.name : JSON.stringify(a) === JSON.stringify(b));

/** `{ data: Invoice }` style single-record envelopes. */
function itemWrapProp(resp: Shape | undefined, item: Shape, key: string, types: Types): string | undefined {
  if (!resp || sameShape(resp, item)) return undefined;
  const r = resolve(resp, types);
  if (r.kind !== 'object') return undefined;
  const hit = r.props.find((p) => sameShape(p.shape, item)) ?? r.props.find((p) => /^(data|item|result|record)$/.test(p.name) || p.name === camel(singular(key)));
  if (!hit) return undefined;
  const x = resolve(hit.shape, types);
  return x.kind === 'object' ? hit.name : undefined;
}

/** What a resource looks like when the spec has no schema, by its name. */
export function guessShape(key: string): Shape {
  const s = (kind: 'string', format?: string): Shape => ({ kind, ...(format ? { format } : {}) });
  const p = (name: string, shape: Shape, required = true): Prop => ({ name, shape, required });
  const k = key.toLowerCase();
  if (/^(me|user|users|profile|members?|people|person|customers?|contacts?|employees?|owners?|admins?|staff)$/.test(k)) {
    return { kind: 'object', props: [p('id', s('string')), p('name', s('string')), p('email', s('string', 'email')), p('role', s('string')), p('avatarUrl', s('string', 'uri')), p('createdAt', s('string', 'date-time'))] };
  }
  if (/(payment|invoice|order|transaction|charge|refund|payout|bill|expense|subscription|transfer|deposit|purchase|receipt)/.test(k)) {
    return { kind: 'object', props: [p('id', s('string')), p('reference', s('string')), p('vendor', s('string')), p('amount', { kind: 'number', integer: false }), p('currency', s('string')), p('status', { kind: 'string', enum: ['paid', 'pending', 'failed'] }), p('createdAt', s('string', 'date-time'))] };
  }
  if (/^(account|organi[sz]ations?|company|companies|workspaces?|teams?|tenants?|orgs?)$/.test(k)) {
    return { kind: 'object', props: [p('id', s('string')), p('name', { kind: 'string' }), p('status', { kind: 'string' }), p('plan', s('string')), p('createdAt', s('string', 'date-time'))] };
  }
  return { kind: 'object', props: [p('id', s('string')), p('name', s('string')), p('description', s('string')), p('status', s('string')), p('createdAt', s('string', 'date-time')), p('updatedAt', s('string', 'date-time'))] };
}

const VERB_STATUS: Record<string, string[]> = {
  approve: ['approved', 'active'],
  reject: ['rejected', 'declined'],
  decline: ['declined', 'rejected'],
  cancel: ['canceled', 'cancelled'],
  archive: ['archived'],
  unarchive: ['active'],
  publish: ['published', 'live'],
  unpublish: ['draft', 'unpublished'],
  freeze: ['frozen', 'suspended'],
  unfreeze: ['active'],
  activate: ['active', 'enabled'],
  deactivate: ['inactive', 'disabled'],
  enable: ['enabled', 'active'],
  disable: ['disabled', 'inactive'],
  suspend: ['suspended', 'paused'],
  pause: ['paused', 'suspended'],
  resume: ['active', 'running'],
  close: ['closed'],
  reopen: ['open', 'active'],
  open: ['open'],
  complete: ['completed', 'done'],
  finish: ['completed', 'done', 'finished'],
  pay: ['paid'],
  refund: ['refunded'],
  void: ['void', 'voided'],
  send: ['sent'],
  submit: ['submitted', 'pending'],
  lock: ['locked'],
  unlock: ['active', 'unlocked'],
  verify: ['verified'],
  confirm: ['confirmed'],
  ship: ['shipped'],
  deliver: ['delivered'],
  start: ['started', 'running', 'in_progress'],
  stop: ['stopped'],
  retry: ['pending', 'queued'],
};

function statusFor(verb: string, props: Prop[], types: Types): string | undefined {
  const v = verb.toLowerCase().replace(/[^a-z]/g, '');
  const cands = VERB_STATUS[v] ?? VERB_STATUS[v.replace(/e?d$/, '')];
  if (!cands) return undefined;
  const st = props.find((p) => p.name === 'status' || p.name === 'state');
  if (!st) return undefined;
  const r = resolve(st.shape, types);
  if (r.kind !== 'string') return undefined;
  if (r.enum) return cands.find((c) => r.enum!.includes(c));
  return cands[0];
}

const PAGING = {
  limit: /^(limit|per_?page|perPage|page_?size|pageSize|size|take|first)$/,
  page: /^(page|page_?number|pageNumber|p)$/,
  offset: /^(offset|skip|start)$/,
};

const TEXT_FIELD = /(name|title|subject|label|description|summary|bio|note|notes|comment|body|content|message|memo|details|text|reason|vendor|merchant|company|customer|address|city|headline|reference)$/i;

/** Decide which operations read and write which mock DB collections. */
export function plan(src: ApiSource): ApiPlan {
  const types: Types = new Map(src.types);
  const ops = src.ops;
  const usedKeys = new Set<string>();
  const uniqueKey = (k: string) => {
    let key = k || 'items';
    for (let i = 2; usedKeys.has(key); i++) key = `${k}${i}`;
    usedKeys.add(key);
    return key;
  };
  const registerType = (name: string, shape: Shape): string => {
    if (shape.kind === 'ref') return shape.name;
    let n = pascal(name);
    while (types.has(n)) n += 'Item';
    types.set(n, shape);
    return n;
  };

  // 1. Collection bases: paths with a `/{id}` child, or GETs that return lists.
  const bases = new Map<string, { segs: string[] }>();
  for (const op of ops) {
    const last = op.segs.at(-1);
    if (op.segs.length >= 2 && last && isParam(last) && !isParam(op.segs.at(-2)!)) bases.set(norm(op.segs.slice(0, -1)), { segs: op.segs.slice(0, -1) });
  }
  for (const op of ops) {
    const last = op.segs.at(-1);
    if (op.method !== 'GET' || !last || isParam(last)) continue;
    const list = listInfo(op.response, types);
    if (list || (!op.response && isPlural(last) && !op.segs.slice(0, -1).some(isParam))) bases.set(norm(op.segs), { segs: op.segs });
  }

  // 2. Collections, parents first.
  const collections: Collection[] = [];
  const byBase = new Map<string, Collection>();
  for (const [base, { segs }] of [...bases].sort((a, b) => a[1].segs.length - b[1].segs.length)) {
    const seg = segs.at(-1)!;
    const parentSegs = segs.length >= 3 && isParam(segs.at(-2)!) ? segs.slice(0, -2) : null;
    const parent = parentSegs ? byBase.get(norm(parentSegs)) : undefined;
    const key = uniqueKey(parent ? camel(`${singular(parent.key)}-${seg}`) : camel(seg));
    const list = ops.find((o) => o.method === 'GET' && norm(o.segs) === base);
    const get = ops.find((o) => o.method === 'GET' && o.segs.length === segs.length + 1 && norm(o.segs.slice(0, -1)) === base && isParam(o.segs.at(-1)!));
    const create = ops.find((o) => o.method === 'POST' && norm(o.segs) === base);
    const listItem = listInfo(list?.response, types)?.item;
    let item: Shape | undefined = listItem;
    if (!item && get?.response) {
      const r = resolve(get.response, types);
      const wrapped = r.kind === 'object' ? r.props.find((p) => /^(data|item|result|record)$/.test(p.name)) : undefined;
      item = wrapped && resolve(wrapped.shape, types).kind === 'object' ? wrapped.shape : get.response;
    }
    if (!item && create?.request) item = create.request;
    if (!item || resolve(item, types).kind !== 'object') item = guessShape(key);
    const typeName = registerType(singular(pascal(key)), item);
    const props = propsOf({ kind: 'ref', name: typeName }, types);
    const sing = camel(singular(seg));
    const idProp = props.find((p) => p.name === 'id') ?? props.find((p) => p.name === `${sing}Id` || p.name === `${sing}_id`) ?? props.find((p) => p.name === 'uuid' || p.name === '_id');
    const added: { name: string; ts: string }[] = [];
    let idKind: Collection['idKind'] = 'string';
    if (idProp) {
      const r = resolve(idProp.shape, types);
      idKind = r.kind === 'number' ? 'int' : r.kind === 'string' && r.format === 'uuid' ? 'uuid' : 'string';
    } else added.push({ name: 'id', ts: 'string' });
    const coll: Collection = {
      key,
      base,
      typeName,
      idField: idProp?.name ?? 'id',
      idKind,
      idPrefix: (singular(seg).replace(/[^A-Za-z]/g, '').slice(0, 3) || 'id').toLowerCase(),
      added,
      props,
      textFields: props
        .filter((p) => {
          const r = resolve(p.shape, types);
          return r.kind === 'string' && !r.enum && !r.format && !isIdField(p.name) && TEXT_FIELD.test(p.name) && !/(email|url|uri|status|type)$/i.test(p.name);
        })
        .map((p) => p.name),
    };
    if (parent) {
      const fk = `${camel(singular(parent.key))}Id`;
      coll.parent = { coll: parent, fk };
      if (!props.some((p) => p.name === fk)) added.push({ name: fk, ts: parent.idKind === 'int' ? 'number' : 'string' });
    }
    collections.push(coll);
    byBase.set(base, coll);
  }

  // 3. Singletons: GETs of static paths that are not collections.
  const singletons: Singleton[] = [];
  const singleByBase = new Map<string, Singleton>();
  for (const op of ops) {
    const base = norm(op.segs);
    if (op.method !== 'GET' || !op.segs.length || op.segs.some(isParam) || byBase.has(base) || singleByBase.has(base)) continue;
    const r = op.response ? resolve(op.response, types) : undefined;
    if (r && r.kind !== 'object') continue;
    const seg = op.segs.at(-1)!;
    const key = uniqueKey(camel(seg));
    const shape = op.response ?? guessShape(seg);
    const typeName = registerType(pascal(seg), shape);
    const s: Singleton = { key, base, typeName, props: propsOf({ kind: 'ref', name: typeName }, types) };
    singletons.push(s);
    singleByBase.set(base, s);
  }

  // 4. One plan per operation.
  const handlers: Plan[] = [];
  const parentParamOf = (segs: string[], coll: Collection) => (coll.parent ? paramName(segs[segs.length - 2]!) : undefined);
  for (const op of ops) {
    const segs = op.segs;
    const base = norm(segs);
    const last = segs.at(-1);
    const coll = byBase.get(base);
    if (coll) {
      if (op.method === 'GET') {
        const info = listInfo(op.response, types);
        const qnames = op.query.map((q) => q.name);
        const paging: Paging = {};
        for (const [k, re] of Object.entries(PAGING) as [keyof typeof PAGING, RegExp][]) {
          const q = op.query.find((x) => re.test(x.name));
          if (q) paging[k] = q.name;
        }
        const limitQ = op.query.find((q) => q.name === paging.limit);
        if (typeof limitQ?.default === 'number') paging.defaultLimit = limitQ.default;
        else if (paging.page && paging.limit) paging.defaultLimit = 20;
        const used = new Set([paging.limit, paging.page, paging.offset]);
        const filters = qnames.filter((n) => !used.has(n) && (coll.props.some((p) => p.name === n && ['string', 'number', 'boolean'].includes(resolve(p.shape, types).kind)) || coll.added.some((a) => a.name === n)));
        handlers.push({ kind: 'list', op, coll, ...(info?.wrapper ? { wrapper: info.wrapper } : {}), filters, paging, parentParam: segs.length >= 2 && coll.parent ? paramName(segs.at(-2)!) : undefined });
        continue;
      }
      if (op.method === 'POST') {
        handlers.push({ kind: 'create', op, coll, parentParam: coll.parent ? paramName(segs.at(-2)!) : undefined, wrapProp: itemWrapProp(op.response, { kind: 'ref', name: coll.typeName }, coll.key, types) });
        continue;
      }
    }
    const itemColl = last && isParam(last) && segs.length >= 2 ? byBase.get(norm(segs.slice(0, -1))) : undefined;
    if (itemColl) {
      const kind = op.method === 'GET' ? 'get' : op.method === 'DELETE' ? 'delete' : 'update';
      const parentSegs = segs.slice(0, -1);
      handlers.push({ kind, op, coll: itemColl, param: paramName(last!), parentParam: parentParamOf(parentSegs, itemColl), wrapProp: itemWrapProp(op.response, { kind: 'ref', name: itemColl.typeName }, itemColl.key, types) });
      continue;
    }
    const actionColl = segs.length >= 3 && last && !isParam(last) && isParam(segs.at(-2)!) ? byBase.get(norm(segs.slice(0, -2))) : undefined;
    if (actionColl && op.method !== 'GET') {
      const sampleNeeded = op.response && !sameShape(op.response, { kind: 'ref', name: actionColl.typeName }) && !itemWrapProp(op.response, { kind: 'ref', name: actionColl.typeName }, actionColl.key, types);
      handlers.push({ kind: 'action', op, coll: actionColl, param: paramName(segs.at(-2)!), parentParam: parentParamOf(segs.slice(0, -1), actionColl), status: statusFor(last!, actionColl.props, types), ...(sampleNeeded ? { sample: null } : {}) });
      continue;
    }
    const single = singleByBase.get(base);
    if (single && op.method !== 'DELETE') {
      handlers.push({ kind: op.method === 'GET' ? 'singleton-get' : 'singleton-update', op, single });
      continue;
    }
    const parentSingle = segs.length >= 2 && last && !isParam(last) ? singleByBase.get(norm(segs.slice(0, -1))) : undefined;
    if (parentSingle && op.method !== 'GET') {
      const sampleNeeded = op.response && !sameShape(op.response, { kind: 'ref', name: parentSingle.typeName });
      handlers.push({ kind: 'singleton-action', op, single: parentSingle, status: statusFor(last!, parentSingle.props, types), ...(sampleNeeded ? { sample: null } : {}) });
      continue;
    }
    handlers.push({ kind: 'static', op, ...(op.response ? { shape: op.response } : {}) });
  }
  return { types, collections, singletons, handlers };
}
