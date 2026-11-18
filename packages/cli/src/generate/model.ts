import { fakeValue, isIdField, type Json, type Rng } from '@stagecraft/core';

/** Source-independent description of a data shape (from OpenAPI schemas or TypeScript types). */
export type Shape = (
  | { kind: 'string'; format?: string; enum?: string[]; maxLength?: number }
  | { kind: 'number'; integer: boolean; minimum?: number; maximum?: number; enum?: number[] }
  | { kind: 'boolean' }
  | { kind: 'array'; items: Shape; minItems?: number; maxItems?: number }
  | { kind: 'object'; props: Prop[]; additional?: Shape }
  | { kind: 'ref'; name: string }
  | { kind: 'union'; options: Shape[] }
  | { kind: 'const'; value: Json }
  | { kind: 'unknown' }
) & { nullable?: boolean; description?: string };

export interface Prop {
  name: string;
  shape: Shape;
  required: boolean;
}

/** Named types, in declaration order. */
export type Types = Map<string, Shape>;

export const IDENT = /^[A-Za-z_$][\w$]*$/;

export function pascal(s: string) {
  const out = s
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (c) => c.toUpperCase());
  return /^[0-9]/.test(out) ? `T${out}` : out || 'Item';
}

export function camel(s: string) {
  const p = pascal(s);
  return p[0]!.toLowerCase() + p.slice(1);
}

export function singular(word: string) {
  if (/people$/i.test(word)) return word.replace(/ople$/i, 'rson');
  if (/(status|address|access|business|class|alias|news|series|canvas|analysis)$/i.test(word)) return word;
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/(ss|x|ch|sh|z)es$/i.test(word)) return word.replace(/es$/i, '');
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

export function isPlural(word: string) {
  return singular(word) !== word || /people$/i.test(word);
}

export function resolve(shape: Shape, types: Types, seen = 0): Shape {
  if (shape.kind !== 'ref' || seen > 20) return shape;
  const t = types.get(shape.name);
  if (!t) return { kind: 'unknown' };
  const r = resolve(t, types, seen + 1);
  return shape.nullable ? { ...r, nullable: true } : r;
}

export function propsOf(shape: Shape, types: Types): Prop[] {
  const r = resolve(shape, types);
  return r.kind === 'object' ? r.props : [];
}

// ---------- TypeScript type text ----------

const quoteKey = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

export function tsType(shape: Shape, indent = ''): string {
  const base = tsTypeBase(shape, indent);
  return shape.nullable && base !== 'unknown' && base !== 'null' ? `${base} | null` : base;
}

function wrap(t: string) {
  return /[|&]/.test(t) && !/^[{(]/.test(t) ? `(${t})` : t;
}

function tsTypeBase(s: Shape, indent: string): string {
  switch (s.kind) {
    case 'string':
      return s.enum?.length ? s.enum.map((v) => JSON.stringify(v)).join(' | ') : 'string';
    case 'number':
      return s.enum?.length ? s.enum.map((v) => String(v)).join(' | ') : 'number';
    case 'boolean':
      return 'boolean';
    case 'const':
      return JSON.stringify(s.value);
    case 'ref':
      return s.name;
    case 'unknown':
      return 'unknown';
    case 'array':
      return `${wrap(tsType(s.items, indent))}[]`;
    case 'union': {
      const parts = [...new Set(s.options.map((o) => tsType(o, indent)))];
      return parts.length ? parts.join(' | ') : 'unknown';
    }
    case 'object': {
      if (!s.props.length && !s.additional) return 'Record<string, unknown>';
      if (!s.props.length && s.additional) return `Record<string, ${tsType(s.additional, indent)}>`;
      const inner = indent + '  ';
      const lines = s.props.map((p) => `${inner}${quoteKey(p.name)}${p.required ? '' : '?'}: ${tsType(p.shape, inner)};`);
      if (s.additional) lines.push(`${inner}[key: string]: unknown;`);
      return `{\n${lines.join('\n')}\n${indent}}`;
    }
  }
}

/** `export interface X {...}` for objects, `export type X = ...` otherwise. */
export function tsDeclaration(name: string, shape: Shape): string {
  const doc = shape.description ? `/** ${shape.description.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()} */\n` : '';
  if (shape.kind === 'object' && shape.props.length && !shape.nullable) {
    const body = tsType(shape, '');
    return `${doc}export interface ${name} ${body}`;
  }
  return `${doc}export type ${name} = ${tsType(shape, '')};`;
}

// ---------- fake values ----------

export interface GenContext {
  rng: Rng;
  types: Types;
  /** Index of the record in its collection (0 = first, used for "most common" enum values). */
  index: number;
  depth: number;
  /** Named types on the current path, to stop recursive schemas. */
  stack: string[];
  /** Foreign keys: `customerId` → ids of the `customers` collection. */
  foreignKeys: Map<string, Json[]>;
  /** Named type of the record being generated. */
  entity?: string;
}

/** Timestamps of events most records have not reached yet. */
const TERMINAL = /^(deleted|archived|cancell?ed|canceled|paid|closed|completed|ended|resolved|refunded|voided|failed|expired)(At|_at|On|_on)$/;

export function genValue(shape: Shape, field: string, ctx: GenContext): Json {
  if (shape.nullable && ctx.depth > 0 && (TERMINAL.test(field) ? ctx.rng.bool(0.6) : ctx.index > 0 && ctx.rng.bool(0.15))) return null;
  if (ctx.depth > 12) return shape.kind === 'array' ? [] : null;
  switch (shape.kind) {
    case 'ref': {
      const t = ctx.types.get(shape.name);
      if (!t) return null;
      if (ctx.stack.filter((n) => n === shape.name).length >= 1 && ctx.depth > 2) {
        // Recursive type: stop with the smallest valid value.
        if (shape.nullable || t.nullable) return null;
        const r = resolve(t, ctx.types);
        if (r.kind === 'array') return [];
      }
      return genValue({ ...t, nullable: shape.nullable || t.nullable }, field, { ...ctx, stack: [...ctx.stack, shape.name], entity: t.kind === 'object' ? shape.name : ctx.entity });
    }
    case 'const':
      return shape.value;
    case 'unknown':
      return null;
    case 'boolean':
      return fakeValue(ctx.rng, field, { type: 'boolean', index: ctx.index, entity: ctx.entity }) as boolean;
    case 'string': {
      const fk = foreignKey(field, ctx);
      if (fk !== undefined && !shape.enum && !shape.format) return fk;
      return fakeValue(ctx.rng, field, { type: 'string', format: shape.format, enum: shape.enum, maxLength: shape.maxLength, index: ctx.index, entity: ctx.entity });
    }
    case 'number': {
      const fk = foreignKey(field, ctx);
      if (typeof fk === 'number' && !shape.enum) return fk;
      return fakeValue(ctx.rng, field, { type: shape.integer ? 'integer' : 'number', enum: shape.enum, minimum: shape.minimum, maximum: shape.maximum, index: ctx.index, entity: ctx.entity });
    }
    case 'array': {
      const deep = ctx.depth >= 3;
      const min = shape.minItems ?? 0;
      const max = shape.maxItems ?? (deep ? 0 : 3);
      const n = Math.max(min, Math.min(max, deep ? 0 : ctx.rng.int(1, 3)));
      const itemField = singular(field);
      return Array.from({ length: n }, (_, i) => genValue(shape.items, itemField, { ...ctx, depth: ctx.depth + 1, index: i }));
    }
    case 'union': {
      const opts = shape.options.filter((o) => o.kind !== 'unknown');
      if (!opts.length) return null;
      const pick = ctx.index === 0 ? opts[0]! : ctx.rng.pick(opts);
      return genValue(pick, field, ctx);
    }
    case 'object': {
      const out: Record<string, Json> = {};
      for (const p of shape.props) {
        if (!p.required && ctx.depth >= 2) continue;
        out[p.name] = genValue(p.shape, p.name, { ...ctx, depth: ctx.depth + 1 });
      }
      if (!shape.props.length && shape.additional) {
        for (let i = 1; i <= 2; i++) out[`${singular(field) || 'key'}${i}`] = genValue(shape.additional, field, { ...ctx, depth: ctx.depth + 1 });
      }
      return out;
    }
  }
}

function foreignKey(field: string, ctx: GenContext): Json | undefined {
  if (!isIdField(field) || field === 'id' || field === 'ID') return undefined;
  const ids = ctx.foreignKeys.get(field.replace(/(_id|Id|ID)$/, '').toLowerCase());
  return ids && ids.length ? ctx.rng.pick(ids) : undefined;
}

/** Render a JSON value as TypeScript source with stable formatting. */
export function literal(v: Json, indent = ''): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => inner + literal(x, inner)).join(',\n')},\n${indent}]`;
  }
  const entries = Object.entries(v);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, x]) => `${inner}${quoteKey(k)}: ${literal(x, inner)}`).join(',\n')},\n${indent}}`;
}
