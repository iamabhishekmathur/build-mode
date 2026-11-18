import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
// @ts-ignore - no bundled types
import pixelmatch from 'pixelmatch';
// @ts-ignore - no bundled types
import { PNG } from 'pngjs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { cellUrl, launch, openCell, outDir, type Cell } from './browser.ts';
import { designSystem } from './components.ts';
import { result, type CheckResult, type Finding } from './util.ts';

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Share of pixels in the region that differ. */
  diff: number;
}

/** Group differing pixels into boxes: a coarse grid, then merge touching cells. */
export function diffRegions(mask: Uint8Array, w: number, h: number, cell = 16, minShare = 0.04): Region[] {
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const share = new Float32Array(cols * rows);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) share[Math.floor(y / cell) * cols + Math.floor(x / cell)]! += 1;
  for (let i = 0; i < share.length; i++) share[i]! /= cell * cell;
  const seen = new Uint8Array(cols * rows);
  const out: Region[] = [];
  for (let i = 0; i < share.length; i++) {
    if (seen[i] || share[i]! < minShare) continue;
    let [x0, y0, x1, y1, sum, n] = [cols, rows, 0, 0, 0, 0];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const cx = k % cols;
      const cy = Math.floor(k / cols);
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      sum += share[k]!;
      n++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        const j = ny * cols + nx;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !seen[j] && share[j]! >= minShare) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    out.push({ x: x0 * cell, y: y0 * cell, width: Math.min(w, (x1 + 1) * cell) - x0 * cell, height: Math.min(h, (y1 + 1) * cell) - y0 * cell, diff: Math.round((sum / n) * 100) / 100 });
  }
  return out.sort((a, b) => b.width * b.height * b.diff - a.width * a.height * a.diff);
}

export interface FigmaOptions {
  base: string;
  root: string;
  route: string;
  /** PNG export of the Figma frame (at 1x). Its size sets the viewport. */
  reference: string;
  cell?: Cell;
  session?: string;
  /** Per-pixel color tolerance 0–1 (pixelmatch). Default 0.1. */
  threshold?: number;
}

/**
 * FR-1002 / FR-1204: compare a view with a Figma frame. Pixel diff at the frame's size,
 * a 0–100 similarity score and the regions that differ. The agent judges layout, spacing,
 * type and components from the three images (reference, actual, diff).
 */
export async function checkFigma(opts: FigmaOptions): Promise<CheckResult & { score: number; regions: Region[]; images: { reference: string; actual: string; diff: string } }> {
  const t0 = Date.now();
  const ref = PNG.sync.read(readFileSync(opts.reference));
  const { width, height } = ref;
  const dir = outDir(opts.root, 'figma');
  const browser = await launch();
  let actualBuf: Buffer;
  try {
    const cell: Cell = { ...(opts.cell ?? {}), viewport: { width, height } };
    const { page } = await openCell(browser, cellUrl(opts.base, opts.route, cell, opts.session), cell);
    actualBuf = await page.screenshot({ clip: { x: 0, y: 0, width, height }, fullPage: true });
    await page.close();
  } finally {
    await browser.close();
  }
  const actual = PNG.sync.read(actualBuf);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(ref.data, actual.data, diff.data, width, height, { threshold: opts.threshold ?? 0.1, includeAA: false });
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = diff.data[i * 4]!;
    const g = diff.data[i * 4 + 1]!;
    const b = diff.data[i * 4 + 2]!;
    if (r > 200 && g < 80 && b < 80) mask[i] = 1; // pixelmatch paints differences red
  }
  const regions = diffRegions(mask, width, height);
  const score = Math.round((1 - changed / (width * height)) * 1000) / 10;
  const files = { reference: join(dir, 'reference.png'), actual: join(dir, 'actual.png'), diff: join(dir, 'diff.png') };
  writeFileSync(files.reference, readFileSync(opts.reference));
  writeFileSync(files.actual, actualBuf);
  writeFileSync(files.diff, PNG.sync.write(diff));
  const findings: Finding[] = regions.slice(0, 12).map((r) => ({
    rule: 'figma-diff',
    severity: r.diff > 0.25 && r.width * r.height > 2000 ? 'error' : 'warning',
    message: `Differs from the frame at x=${r.x} y=${r.y} (${r.width}×${r.height}px, ${Math.round(r.diff * 100)}% of pixels)`,
    where: opts.route,
  }));
  return { ...result('figma', t0, findings, { notes: [`Pixel similarity ${score}/100 at ${width}×${height}. Pixel diff is strict: check the images for real layout, spacing, type and component differences.`], artifacts: Object.values(files) }), score, regions, images: files };
}

// ---------------- Figma variables → code tokens (FR-1203) ----------------

function normColor(v: string): string | null {
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return '#' + m[1]!.split('').map((c) => c + c).join('');
  m = /^#([0-9a-f]{6})(?:ff)?$/.exec(s);
  if (m) return '#' + m[1];
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+(1|1\.0+|100%))?\s*\)$/.exec(s);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  return null;
}

export function normValue(v: unknown): string {
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  const c = normColor(s);
  if (c) return c;
  const px = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(s);
  if (px) return String(Number(px[1]));
  return s.toLowerCase();
}

/** Flatten Figma variables: `{ "color/brand": "#3B4EE8" }` (Figma MCP get_variable_defs) or nested objects. */
export function flattenVars(input: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const key = prefix ? `${prefix}/${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const val = (v as any).value ?? (v as any).$value;
        if (val !== undefined && typeof val !== 'object') out[key] = String(val);
        else Object.assign(out, flattenVars(v, key));
      } else if (v !== undefined && v !== null) out[key] = String(v);
    }
  }
  return out;
}

function walk(dir: string, re: RegExp, out: string[] = [], depth = 6): string[] {
  if (depth < 0 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.') || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, re, out, depth - 1);
    else if (re.test(e)) out.push(p);
  }
  return out;
}

/** Code tokens: CSS custom properties, plus string/number leaves of `tokens`/`theme` object literals. */
export function codeTokens(dirs: string[], root: string): { name: string; value: string; file: string }[] {
  const out: { name: string; value: string; file: string }[] = [];
  for (const dir of dirs) {
    for (const f of walk(dir, /\.(css|scss)$/)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(--[\w-]+)\s*:\s*([^;}{]+);/g)) out.push({ name: m[1]!, value: m[2]!.trim(), file: relative(root, f) });
    }
    for (const f of walk(dir, /(token|theme)[^/]*\.(m?[jt]sx?)$|index\.(m?[jt]sx?)$/i)) {
      const src = readFileSync(f, 'utf8');
      const block = /(?:export\s+const\s+(tokens|theme)\s*=\s*)(\{[\s\S]*?\n\})/.exec(src);
      if (!block) continue;
      const stack: string[] = [block[1]!];
      for (const line of block[2]!.split('\n')) {
        const open = /^\s*['"]?([\w-]+)['"]?\s*:\s*\{/.exec(line);
        const leaf = [...line.matchAll(/['"]?([\w-]+)['"]?\s*:\s*(['"][^'"]+['"]|-?\d+(?:\.\d+)?)/g)];
        if (open) stack.push(open[1]!);
        else for (const m of leaf) out.push({ name: [...stack, m[1]].join('.'), value: m[2]!.replace(/^['"]|['"]$/g, ''), file: relative(root, f) });
        if (/^\s*\}/.test(line) && stack.length > 1) stack.pop();
        else if (open && /\}\s*,?\s*$/.test(line.slice(line.indexOf('{') + 1))) {
          for (const m of [...line.slice(line.indexOf('{') + 1).matchAll(/['"]?([\w-]+)['"]?\s*:\s*(['"][^'"]+['"]|-?\d+(?:\.\d+)?)/g)]) out.push({ name: [...stack, m[1]].join('.'), value: m[2]!.replace(/^['"]|['"]$/g, ''), file: relative(root, f) });
          stack.pop();
        }
      }
    }
  }
  return out;
}

export function mapTokens(figmaVars: Record<string, string>, tokens: { name: string; value: string; file: string }[]) {
  const byValue = new Map<string, typeof tokens>();
  for (const t of tokens) {
    const k = normValue(t.value);
    byValue.set(k, [...(byValue.get(k) ?? []), t]);
  }
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const mapped: { figma: string; value: string; code: string; file: string }[] = [];
  const unmapped: { figma: string; value: string }[] = [];
  for (const [name, value] of Object.entries(figmaVars)) {
    const cands = byValue.get(normValue(value)) ?? [];
    if (!cands.length) {
      unmapped.push({ figma: name, value });
      continue;
    }
    const w = words(name);
    const best = [...cands].sort((a, b) => [...words(b.name)].filter((x) => w.has(x)).length - [...words(a.name)].filter((x) => w.has(x)).length)[0]!;
    mapped.push({ figma: name, value, code: best.name, file: best.file });
  }
  return { mapped, unmapped };
}

/** Where tokens live: the repo's src plus each design-system package. */
export function tokenDirs(root: string): string[] {
  const dirs = [join(root, 'src')];
  const req = createRequire(join(root, 'package.json'));
  for (const p of designSystem(root).packages) {
    try {
      dirs.push(dirname(req.resolve(`${p}/package.json`)));
    } catch {
      /* not resolvable */
    }
  }
  return dirs;
}
