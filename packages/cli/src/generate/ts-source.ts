import { resolve as resolvePath } from 'node:path';
import type { ApiOp, ApiSource } from './openapi.ts';
import { isPlural, type Prop, type Shape, type Types } from './model.ts';

export interface TypeMapping {
  /** Exported type name, e.g. `Invoice`. */
  type: string;
  /** Route path, e.g. `/v1/invoices`. */
  path: string;
  /** Collection (CRUD on `path` and `path/:id`) or singleton (GET/PATCH on `path`). Default: plural last segment → collection. */
  collection?: boolean;
}

/** Parse `Invoice:/v1/invoices`, `Invoice[]:/v1/invoices` (force collection) or `Account!:/v1/account` (force singleton). */
export function parseTypeMapping(s: string): TypeMapping {
  const m = /^([A-Za-z_$][\w$]*)(\[\]|!)?:(\/.*)$/.exec(s.trim());
  if (!m) throw new Error(`Bad --type "${s}". Use Name:/path, e.g. Invoice:/v1/invoices (add [] to force a collection, ! for a singleton).`);
  return { type: m[1]!, path: m[3]!.replace(/\/$/, '') || '/', ...(m[2] === '[]' ? { collection: true } : m[2] === '!' ? { collection: false } : {}) };
}

/**
 * Read exported interfaces and type aliases from a TypeScript file with the compiler API
 * and turn the mappings into REST operations.
 */
export async function readTsSource(file: string, mappings: TypeMapping[]): Promise<ApiSource> {
  let ts: typeof import('typescript');
  try {
    const mod: any = await import('typescript');
    ts = mod.default ?? mod;
  } catch {
    throw new Error('Reading TypeScript types needs the "typescript" package. Install it (npm i -D typescript) and run again.');
  }
  const abs = resolvePath(file);
  const program = ts.createProgram([abs], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
  });
  const sf = program.getSourceFile(abs);
  if (!sf) throw new Error(`Cannot read ${file}`);
  const checker = program.getTypeChecker();
  const modSym = checker.getSymbolAtLocation(sf);
  const exported = modSym ? checker.getExportsOfModule(modSym) : [];
  const nameOf = new Map<import('typescript').Symbol, string>();
  for (let sym of exported) {
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    if (!(sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) continue;
    const decl = sym.declarations?.[0] as any;
    if (decl?.typeParameters?.length) continue; // generics are expanded where used
    nameOf.set(sym, sym.getName());
  }
  const types: Types = new Map();

  const refName = (t: import('typescript').Type) => {
    const s = t.aliasSymbol ?? t.symbol;
    return s ? nameOf.get(s) : undefined;
  };

  function conv(t: import('typescript').Type, depth: number, top = false): Shape {
    if (depth > 30) return { kind: 'unknown' };
    const named = refName(t);
    if (named && !top) return { kind: 'ref', name: named };
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { kind: 'unknown' };
    if (f & ts.TypeFlags.StringLiteral) return { kind: 'const', value: (t as import('typescript').StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral) return { kind: 'const', value: (t as import('typescript').NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral) return { kind: 'const', value: (t as any).intrinsicName === 'true' };
    if (f & ts.TypeFlags.String || f & ts.TypeFlags.TemplateLiteral) return { kind: 'string' };
    if (f & ts.TypeFlags.Number || f & ts.TypeFlags.BigInt) return { kind: 'number', integer: false };
    if (f & ts.TypeFlags.Boolean) return { kind: 'boolean' };
    if (f & ts.TypeFlags.Null) return { kind: 'const', value: null };
    if (f & ts.TypeFlags.EnumLike && t.isUnion()) return conv(checker.getBaseTypeOfLiteralType(t), depth + 1);
    if (t.isUnion()) {
      const parts = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
      const nullable = parts.some((x) => x.flags & ts.TypeFlags.Null);
      const rest = parts.filter((x) => !(x.flags & ts.TypeFlags.Null));
      const extra = nullable ? { nullable: true } : {};
      if (rest.length && rest.every((x) => x.flags & ts.TypeFlags.BooleanLiteral)) return { kind: 'boolean', ...extra };
      if (rest.length && rest.every((x) => x.flags & ts.TypeFlags.StringLiteral)) return { kind: 'string', enum: rest.map((x) => (x as import('typescript').StringLiteralType).value), ...extra };
      if (rest.length && rest.every((x) => x.flags & ts.TypeFlags.NumberLiteral)) return { kind: 'number', integer: true, enum: rest.map((x) => (x as import('typescript').NumberLiteralType).value), ...extra };
      const bools = rest.filter((x) => x.flags & ts.TypeFlags.BooleanLiteral);
      const opts = rest.filter((x) => !(x.flags & ts.TypeFlags.BooleanLiteral)).map((x) => conv(x, depth + 1));
      // `boolean | X` arrives as `true | false | X`.
      if (bools.length === 2) opts.push({ kind: 'boolean' });
      else opts.push(...bools.map((b) => conv(b, depth + 1)));
      const fixed = opts;
      return fixed.length === 1 ? { ...fixed[0]!, ...extra } : { kind: 'union', options: fixed, ...extra };
    }
    if (checker.isArrayType(t) || checker.isTupleType(t)) {
      const args = checker.getTypeArguments(t as import('typescript').TypeReference);
      const item = args.length === 1 ? conv(args[0]!, depth + 1) : { kind: 'union' as const, options: args.map((a) => conv(a, depth + 1)) };
      return { kind: 'array', items: item };
    }
    if (t.symbol?.getName() === 'Date') return { kind: 'string', format: 'date-time' };
    if (f & ts.TypeFlags.Object || t.isIntersection()) {
      const props: Prop[] = checker.getPropertiesOfType(t).map((p) => {
        const pt = checker.getTypeOfSymbol(p);
        return { name: p.getName(), shape: conv(pt, depth + 1), required: !(p.flags & ts.SymbolFlags.Optional) };
      });
      const index = checker.getIndexInfoOfType(t, ts.IndexKind.String);
      return { kind: 'object', props, ...(index ? { additional: conv(index.type, depth + 1) } : {}) };
    }
    return { kind: 'unknown' };
  }

  for (const [sym, name] of nameOf) types.set(name, conv(checker.getDeclaredTypeOfSymbol(sym), 0, true));

  const ops: ApiOp[] = [];
  const op = (method: string, path: string, extra: Partial<ApiOp>): ApiOp => {
    const segs = path.split('/').filter(Boolean);
    return { method, route: path.replace(/\{([^}]+)\}/g, ':$1'), segs, query: [], status: 200, hasBody: true, ...extra };
  };
  for (const m of mappings) {
    if (!types.has(m.type)) throw new Error(`${file} does not export a type "${m.type}". Exported: ${[...types.keys()].join(', ') || '(none)'}`);
    const ref: Shape = { kind: 'ref', name: m.type };
    const last = m.path.split('/').filter(Boolean).at(-1) ?? '';
    const collection = m.collection ?? isPlural(last);
    if (collection) {
      const item = `${m.path}/{id}`;
      ops.push(op('GET', m.path, { response: { kind: 'array', items: ref }, query: [{ name: 'limit' }, { name: 'offset' }] }));
      ops.push(op('POST', m.path, { request: ref, response: ref, status: 201 }));
      ops.push(op('GET', item, { response: ref }));
      ops.push(op('PATCH', item, { request: ref, response: ref }));
      ops.push(op('DELETE', item, { status: 204, hasBody: false }));
    } else {
      ops.push(op('GET', m.path, { response: ref }));
      ops.push(op('PATCH', m.path, { request: ref, response: ref }));
    }
  }
  return { types, ops };
}
