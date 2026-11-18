import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { pascal, type Prop, type Shape, type Types } from './model.ts';

/** One API operation, independent of the source format. */
export interface ApiOp {
  method: string;
  /** Route path with the server prefix and `:params`, e.g. `/v1/invoices/:invoiceId`. */
  route: string;
  /** Path segments after the prefix; params as `{name}`. */
  segs: string[];
  query: { name: string; default?: unknown }[];
  request?: Shape;
  response?: Shape;
  /** First 2xx status in the spec (default 200). */
  status: number;
  /** 2xx response has a body. */
  hasBody: boolean;
  operationId?: string;
}

export interface ApiSource {
  types: Types;
  ops: ApiOp[];
  title?: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const SCHEMA_REF = /^#\/components\/schemas\/(.+)$/;

/** Read an OpenAPI 3.x document (JSON or YAML). Local `$ref`s only. */
export function readOpenApiSource(file: string): ApiSource {
  const raw = readFileSync(file, 'utf8');
  const doc = /\.json$/i.test(file) ? JSON.parse(raw) : parseYaml(raw);
  if (!doc || typeof doc !== 'object' || !doc.paths) throw new Error(`${file} is not an OpenAPI document (no "paths")`);
  if (doc.swagger) throw new Error(`${file} is Swagger 2.0. Convert it to OpenAPI 3 first (e.g. with swagger2openapi).`);
  return fromOpenApi(doc);
}

export function fromOpenApi(doc: any): ApiSource {
  const types: Types = new Map();
  const names = new Map<string, string>(); // schema key → TS name
  const used = new Set<string>();
  for (const key of Object.keys(doc.components?.schemas ?? {})) {
    let n = pascal(key);
    while (used.has(n)) n += '_';
    used.add(n);
    names.set(key, n);
  }
  const lookup = (ref: string): any => {
    if (!ref.startsWith('#/')) return undefined;
    let node = doc;
    for (const part of ref.slice(2).split('/')) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return node;
  };
  const conv = (s: any, depth = 0): Shape => toShape(s, depth);

  function toShape(s: any, depth: number): Shape {
    if (!s || typeof s !== 'object' || depth > 40) return { kind: 'unknown' };
    if (typeof s.$ref === 'string') {
      const m = SCHEMA_REF.exec(s.$ref);
      if (m && names.has(decodeURIComponent(m[1]!))) return { kind: 'ref', name: names.get(decodeURIComponent(m[1]!))! };
      const target = lookup(s.$ref);
      return target ? conv(target, depth + 1) : { kind: 'unknown' };
    }
    const nullable = s.nullable === true || (Array.isArray(s.type) && s.type.includes('null'));
    const extra = { ...(nullable ? { nullable: true } : {}), ...(typeof s.description === 'string' ? { description: s.description } : {}) };
    if (s.const !== undefined) return { kind: 'const', value: s.const, ...extra };
    if (Array.isArray(s.allOf)) {
      const parts = s.allOf.map((p: any) => conv(p, depth + 1));
      if (s.properties) parts.push(conv({ type: 'object', properties: s.properties, required: s.required }, depth + 1));
      return { ...mergeAll(parts, getType), ...extra };
    }
    for (const k of ['oneOf', 'anyOf'] as const) {
      if (Array.isArray(s[k])) {
        const opts: Shape[] = s[k].map((p: any) => conv(p, depth + 1));
        const nonNull = opts.filter((o) => !(o.kind === 'const' && o.value === null) && !isNullType(o));
        const isNull = nonNull.length < opts.length;
        if (nonNull.length === 1) return { ...nonNull[0]!, ...(isNull || nullable ? { nullable: true } : {}) };
        if (nonNull.every((o) => o.kind === 'string' && o.enum)) return { kind: 'string', enum: nonNull.flatMap((o) => (o as { enum: string[] }).enum), ...extra };
        return { kind: 'union', options: nonNull, ...(isNull || nullable ? { nullable: true } : {}) };
      }
    }
    const types0 = Array.isArray(s.type) ? s.type.filter((t: string) => t !== 'null') : s.type ? [s.type] : [];
    if (types0.length > 1) return { kind: 'union', options: types0.map((t: string) => conv({ ...s, type: t, nullable: false }, depth + 1)), ...extra };
    let type: string | undefined = types0[0];
    if (!type) {
      if (s.properties || s.additionalProperties) type = 'object';
      else if (s.items) type = 'array';
      else if (Array.isArray(s.enum)) type = typeof s.enum[0] === 'number' ? 'number' : 'string';
    }
    if (Array.isArray(s.enum)) {
      const vals = s.enum.filter((v: unknown) => v !== null);
      if (type === 'string' || vals.every((v: unknown) => typeof v === 'string')) return { kind: 'string', enum: vals.map(String), ...extra, ...(s.enum.includes(null) ? { nullable: true } : {}) };
      if (type === 'integer' || type === 'number') return { kind: 'number', integer: type === 'integer', enum: vals, ...extra };
    }
    switch (type) {
      case 'string':
        return { kind: 'string', ...(s.format ? { format: s.format } : {}), ...(typeof s.maxLength === 'number' ? { maxLength: s.maxLength } : {}), ...extra };
      case 'integer':
      case 'number': {
        const min = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + (type === 'integer' ? 1 : 0.01) : undefined;
        const max = typeof s.maximum === 'number' ? s.maximum : typeof s.exclusiveMaximum === 'number' ? s.exclusiveMaximum - (type === 'integer' ? 1 : 0.01) : undefined;
        return { kind: 'number', integer: type === 'integer', ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}), ...extra };
      }
      case 'boolean':
        return { kind: 'boolean', ...extra };
      case 'null':
        return { kind: 'const', value: null };
      case 'array':
        return { kind: 'array', items: conv(s.items, depth + 1), ...(typeof s.minItems === 'number' ? { minItems: s.minItems } : {}), ...(typeof s.maxItems === 'number' ? { maxItems: s.maxItems } : {}), ...extra };
      case 'object': {
        const req = new Set<string>(Array.isArray(s.required) ? s.required : []);
        const props: Prop[] = Object.entries<any>(s.properties ?? {})
          .filter(([, v]) => !v?.writeOnly)
          .map(([name, v]) => ({ name, shape: conv(v, depth + 1), required: req.has(name) }));
        const additional = s.additionalProperties && typeof s.additionalProperties === 'object' ? conv(s.additionalProperties, depth + 1) : s.additionalProperties === true ? ({ kind: 'unknown' } as Shape) : undefined;
        return { kind: 'object', props, ...(additional ? { additional } : {}), ...extra };
      }
    }
    return { kind: 'unknown', ...extra };
  }

  const byName = new Map([...names].map(([k, n]) => [n, k]));
  const converting = new Set<string>();
  function getType(name: string): Shape | undefined {
    if (types.has(name)) return types.get(name);
    const key = byName.get(name);
    if (key === undefined || converting.has(name)) return undefined;
    converting.add(name);
    const shape = conv(doc.components.schemas[key]);
    converting.delete(name);
    types.set(name, shape);
    return shape;
  }
  for (const name of names.values()) getType(name);
  // Keep declaration order.
  const ordered: Types = new Map([...names.values()].map((n) => [n, types.get(n)!]));
  types.clear();
  for (const [k, v] of ordered) types.set(k, v);

  const prefix = (() => {
    const url = doc?.servers?.[0]?.url;
    if (typeof url !== 'string') return '';
    try {
      return new URL(url, 'http://x').pathname.replace(/\/$/, '');
    } catch {
      return '';
    }
  })();

  const deref = (o: any) => (o && typeof o.$ref === 'string' ? lookup(o.$ref) : o);
  const jsonSchema = (content: any) => {
    if (!content) return undefined;
    const key = Object.keys(content).find((k) => /json/i.test(k)) ?? Object.keys(content)[0];
    return key ? content[key]?.schema : undefined;
  };

  const ops: ApiOp[] = [];
  for (const [p, rawItem] of Object.entries<any>(doc.paths ?? {})) {
    const item = deref(rawItem);
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref).filter(Boolean);
      const query = params.filter((x: any) => x.in === 'query').map((x: any) => ({ name: String(x.name), default: x.schema?.default }));
      const reqSchema = jsonSchema(deref(op.requestBody)?.content);
      const codes = Object.keys(op.responses ?? {}).filter((c) => /^2\d\d$/.test(c)).sort();
      const code = codes[0];
      const res = code ? deref(op.responses[code]) : undefined;
      const resSchema = jsonSchema(res?.content);
      const segs = p.split('/').filter(Boolean);
      ops.push({
        method: m.toUpperCase(),
        route: prefix + p.replace(/\{([^}]+)\}/g, ':$1'),
        segs,
        query,
        ...(reqSchema ? { request: conv(reqSchema) } : {}),
        ...(resSchema ? { response: conv(resSchema) } : {}),
        status: code ? Number(code) : m === 'post' ? 201 : 200,
        hasBody: code ? code !== '204' && !!res?.content : m !== 'delete',
        ...(op.operationId ? { operationId: op.operationId } : {}),
      });
    }
  }
  return { types, ops, title: doc.info?.title };
}

function isNullType(s: Shape) {
  return s.kind === 'const' && s.value === null;
}

/** allOf: merge object members (resolving refs) into one object. */
function mergeAll(parts: Shape[], getType: (name: string) => Shape | undefined): Shape {
  const objects: Shape[] = [];
  for (const p of parts) {
    const r = p.kind === 'ref' ? getType(p.name) : p;
    // A recursive allOf cannot be flattened: keep the first part.
    if (!r) return parts[0]!;
    objects.push(r.kind === 'ref' ? mergeAll([r], getType) : r);
  }
  if (!objects.every((o) => o.kind === 'object')) return objects.find((o) => o.kind !== 'unknown') ?? { kind: 'unknown' };
  const props = new Map<string, Prop>();
  let additional: Shape | undefined;
  for (const o of objects) {
    if (o.kind !== 'object') continue;
    for (const p of o.props) {
      const prev = props.get(p.name);
      props.set(p.name, { ...p, required: p.required || !!prev?.required });
    }
    additional ??= o.additional;
  }
  return { kind: 'object', props: [...props.values()], ...(additional ? { additional } : {}) };
}
