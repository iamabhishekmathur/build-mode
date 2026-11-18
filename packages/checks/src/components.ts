import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { addedLines, changedFiles, CODE, pkgJson, read, result, type CheckResult, type Finding } from './util.ts';

export interface DesignSystemInfo {
  packages: string[];
  /** Exported component names per package. */
  components: Record<string, string[]>;
  /** Exports marked @deprecated. */
  deprecated: Record<string, string[]>;
  /** Files that define tokens: hard-coded values are allowed there. */
  tokenFiles: string[];
}

const COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/;
const SPACING_INLINE = /\b(?:margin|padding|gap|top|left|right|bottom)(?:Top|Bottom|Left|Right|Inline|Block)?\s*:\s*['"]?\d+px/;
const ALLOW = /stagecraft-allow(?::|\s)/;

function exportsOf(src: string) {
  const names = new Set<string>();
  const deprecated = new Set<string>();
  for (const m of src.matchAll(/(\/\*\*(?:(?!\*\/)[\s\S])*?\*\/\s*)?export\s+(?:default\s+)?(?:function|const|class)\s+([A-Z][A-Za-z0-9]*)/g)) {
    names.add(m[2]!);
    if (m[1] && /@deprecated/.test(m[1])) deprecated.add(m[2]!);
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of m[1]!.split(',')) {
    const name = n.trim().split(/\s+as\s+/).pop()!.trim();
    if (/^[A-Z]/.test(name)) names.add(name);
  }
  return { names: [...names], deprecated: [...deprecated] };
}

function walk(dir: string, out: string[] = [], depth = 4): string[] {
  if (depth < 0 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth - 1);
    else if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && !/\.(test|spec|stories)\./.test(e.name)) out.push(p);
  }
  return out;
}

/** Find the design-system packages (config, workspace libraries, or dependency names) and their exports. */
export function designSystem(root: string, hint: string[] = []): DesignSystemInfo {
  const pkg = pkgJson(root);
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const names = [...new Set([...hint, ...deps.filter((d) => /(design-system|^@[^/]+\/ui$|\/components$|-ui$)/.test(d))])];
  const req = createRequire(join(root, 'package.json'));
  const info: DesignSystemInfo = { packages: [], components: {}, deprecated: {}, tokenFiles: [] };
  for (const name of names) {
    let dir: string | null = null;
    try {
      dir = dirname(req.resolve(`${name}/package.json`));
    } catch {
      const p = join(root, 'node_modules', ...name.split('/'));
      if (existsSync(p)) dir = p;
    }
    if (!dir) continue;
    const comps = new Set<string>();
    const dep = new Set<string>();
    for (const f of walk(join(dir, 'src')).concat(walk(dir, [], 0))) {
      const { names: n, deprecated: d } = exportsOf(readFileSync(f, 'utf8'));
      n.forEach((x) => comps.add(x));
      d.forEach((x) => dep.add(x));
      if (/token|theme/i.test(f)) info.tokenFiles.push(f);
    }
    info.packages.push(name);
    info.components[name] = [...comps];
    info.deprecated[name] = [...dep];
  }
  return info;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/**
 * FR-1005: in changed code, flag hard-coded colors and spacing, new components that duplicate
 * design-system ones, and imports of deprecated components. Silence one line with
 * `// stagecraft-allow: <reason>`.
 */
export function checkComponents(root: string, opts: { files?: string[]; designSystem?: string[] } = {}): CheckResult {
  const t0 = Date.now();
  const ds = designSystem(root, opts.designSystem);
  const findings: Finding[] = [];
  const dsNames = Object.entries(ds.components).flatMap(([pkg, cs]) => cs.map((c) => ({ pkg, c })));
  const files = (opts.files ?? changedFiles(root)).filter((f) => CODE.test(f) && !f.startsWith('stagecraft/') && !/(^|\/)(tokens?|theme)[^/]*\.(t|j)sx?$|\.d\.ts$/.test(f) && !/\.(test|spec)\./.test(f));
  for (const file of files) {
    const src = read(join(root, file));
    const added = addedLines(root, file);
    const lines = src.split('\n');
    lines.forEach((text, i) => {
      const n = i + 1;
      if (added && !added.has(n)) return;
      if (ALLOW.test(text) || ALLOW.test(lines[i - 1] ?? '')) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
      if (COLOR.test(text)) findings.push({ rule: 'hard-coded-color', severity: 'error', message: `Hard-coded color "${COLOR.exec(text)![0]}". Use a design token.`, file, line: n });
      else if (SPACING_INLINE.test(text)) findings.push({ rule: 'hard-coded-spacing', severity: 'warning', message: 'Hard-coded spacing in px. Use a spacing token.', file, line: n });
      for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const dep = ds.deprecated[m[2]!] ?? [];
        for (const name of m[1]!.split(',').map((x) => x.trim().split(/\s+as\s+/)[0]!)) {
          if (dep.includes(name)) findings.push({ rule: 'deprecated-component', severity: 'error', message: `${name} from ${m[2]} is deprecated.`, file, line: n });
        }
      }
      const def = /(?:export\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9]*)\s*(?:=\s*(?:\([^)]*\)|[a-z_]\w*)\s*=>|\()/.exec(text);
      if (def) {
        const name = def[1]!;
        const dup = dsNames.find(({ c }) => norm(c) === norm(name) || (norm(name).includes(norm(c)) && norm(c).length >= 4 && /^(button|card|badge|pill|modal|dialog|input|select|table|tabs?|tooltip|avatar|alert|toast|chip|tag|label|link|icon|menu|spinner|switch|checkbox|radio)/.test(norm(c))));
        if (dup && !lines.some((l) => new RegExp(`import[^;]*\\b${dup.c}\\b[^;]*from\\s*['"]${dup.pkg}['"]`).test(l))) {
          findings.push({ rule: 'duplicate-component', severity: 'error', message: `New component ${name} duplicates ${dup.c} from ${dup.pkg}. Use or extend it.`, file, line: n });
        }
      }
    });
  }
  const notes = ds.packages.length ? [`Design system: ${ds.packages.map((p) => `${p} (${ds.components[p]!.length} exports)`).join(', ')}`] : ['No design-system package found: duplicate check limited.'];
  return result('components', t0, findings, { notes });
}
