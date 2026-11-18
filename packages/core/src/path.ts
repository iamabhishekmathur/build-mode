import type { DbPatch, Json, JsonObject, PatchOp } from './types.ts';

/** One step of a parsed path. */
export type Seg =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'match'; field: string; value: string };

export class PathError extends Error {}

/** Parse `users[id=u2].profile.name` or `items[0]`. */
export function parsePath(path: string): Seg[] {
  const segs: Seg[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\[([^=\]]+)=([^\]]*)\]/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  const src = path.trim();
  if (!src) throw new PathError('Empty path');
  while ((m = re.exec(src))) {
    const between = src.slice(pos, m.index);
    if (between !== '' && between !== '.') throw new PathError(`Bad path "${path}" near "${between}"`);
    if (m[1] !== undefined) segs.push({ kind: 'key', key: m[1] });
    else if (m[2] !== undefined) segs.push({ kind: 'index', index: Number(m[2]) });
    else segs.push({ kind: 'match', field: m[3]!, value: m[4]! });
    pos = re.lastIndex;
  }
  if (pos !== src.length) throw new PathError(`Bad path "${path}"`);
  return segs;
}

function step(node: Json | undefined, seg: Seg): Json | undefined {
  if (node === null || node === undefined) return undefined;
  if (seg.kind === 'key') return typeof node === 'object' && !Array.isArray(node) ? node[seg.key] : undefined;
  if (!Array.isArray(node)) return undefined;
  if (seg.kind === 'index') return node[seg.index];
  return node.find((it) => isObj(it) && String(it[seg.field]) === seg.value);
}

export function isObj(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getPath(root: Json, path: string): Json | undefined {
  let node: Json | undefined = root;
  for (const seg of parsePath(path)) node = step(node, seg);
  return node;
}

/** Resolve the parent container and final segment, creating objects on the way for key segments. */
function parentOf(root: Json, segs: Seg[], create: boolean): { parent: Json; last: Seg } {
  let node: Json = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    let next = step(node, seg);
    if (next === undefined || next === null) {
      if (!create || seg.kind !== 'key' || !isObj(node)) {
        throw new PathError(`Path segment ${describe(seg)} not found`);
      }
      next = isNextIndex(segs[i + 1]!) ? [] : {};
      node[seg.key] = next;
    }
    node = next;
  }
  return { parent: node, last: segs[segs.length - 1]! };
}

function isNextIndex(seg: Seg) {
  return seg.kind !== 'key';
}

function describe(seg: Seg) {
  return seg.kind === 'key' ? `"${seg.key}"` : seg.kind === 'index' ? `[${seg.index}]` : `[${seg.field}=${seg.value}]`;
}

function readSlot(parent: Json, last: Seg): Json | undefined {
  return step(parent, last);
}

function writeSlot(parent: Json, last: Seg, value: Json | undefined) {
  if (last.kind === 'key') {
    if (!isObj(parent)) throw new PathError(`Cannot set key "${last.key}" on a non-object`);
    if (value === undefined) delete parent[last.key];
    else parent[last.key] = value;
    return;
  }
  if (!Array.isArray(parent)) throw new PathError(`Cannot index ${describe(last)} on a non-array`);
  let idx = last.kind === 'index' ? last.index : parent.findIndex((it) => isObj(it) && String(it[last.field]) === last.value);
  if (idx < 0) throw new PathError(`No array item matches ${describe(last)}`);
  if (value === undefined) parent.splice(idx, 1);
  else parent[idx] = value;
}

function isOp(v: unknown): v is PatchOp {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && ['$set', '$merge', '$push', '$remove', '$inc'].includes(keys[0]!);
}

export function setPath(root: Json, path: string, value: Json) {
  const { parent, last } = parentOf(root, parsePath(path), true);
  writeSlot(parent, last, value);
}

/** Apply a patch in place. Throws PathError with the failing path. */
export function applyPatch(root: Json, patch: DbPatch): Json {
  for (const [path, raw] of Object.entries(patch)) {
    try {
      const segs = parsePath(path);
      const { parent, last } = parentOf(root, segs, true);
      if (!isOp(raw)) {
        writeSlot(parent, last, clone(raw));
        continue;
      }
      const op = raw as Record<string, Json>;
      if ('$set' in op) writeSlot(parent, last, clone(op.$set!));
      else if ('$remove' in op) writeSlot(parent, last, undefined);
      else if ('$merge' in op) {
        const cur = readSlot(parent, last);
        writeSlot(parent, last, { ...(isObj(cur) ? cur : {}), ...(clone(op.$merge!) as JsonObject) });
      } else if ('$push' in op) {
        const cur = readSlot(parent, last);
        const arr = Array.isArray(cur) ? cur : [];
        arr.push(clone(op.$push!));
        writeSlot(parent, last, arr);
      } else if ('$inc' in op) {
        const cur = readSlot(parent, last);
        writeSlot(parent, last, (typeof cur === 'number' ? cur : 0) + (op.$inc as number));
      }
    } catch (err) {
      if (err instanceof PathError) throw new PathError(`Patch "${path}": ${err.message}`);
      throw err;
    }
  }
  return root;
}

export function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}

/** Simple equality condition used by tape branches. */
export function matches(root: Json, cond: { path: string; equals?: Json; in?: Json[]; exists?: boolean }): boolean {
  let v: Json | undefined;
  try {
    v = getPath(root, cond.path);
  } catch {
    v = undefined;
  }
  if (cond.exists !== undefined) return (v !== undefined) === cond.exists;
  if (cond.in) return cond.in.some((x) => deepEqual(x, v));
  return deepEqual(cond.equals ?? null, v ?? null);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
