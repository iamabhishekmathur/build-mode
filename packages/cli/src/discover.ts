import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { designSystem } from '@stagecraft/checks';
import { detect, Engine, findConfig, readOpenApi, resolveWorkspace, specCoverage } from '@stagecraft/server';
import { doctor, scanEndpoints } from './doctor.ts';

const SKIP = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', 'stagecraft', '.stagecraft-cache']);

function files(dir: string, re: RegExp, out: string[] = [], depth = 8): string[] {
  if (depth < 0 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e) || e.startsWith('.')) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) files(p, re, out, depth - 1);
    else if (re.test(e)) out.push(p);
  }
  return out;
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

// ---------------- Storybook (FR-1301, FR-1302) ----------------

export interface StoryInfo {
  file: string;
  title?: string;
  component?: string;
  stories: { name: string; args?: string }[];
}

/** Parse CSF files: default export (title, component) and named story exports with their args. */
export function readStories(root: string, extraDirs: string[] = []): StoryInfo[] {
  const out: StoryInfo[] = [];
  for (const dir of [root, ...extraDirs]) {
    for (const f of files(dir, /\.stories\.(m?[jt]sx?)$/)) {
      const src = readFileSync(f, 'utf8');
      const meta = /(?:export\s+default|const\s+meta\s*(?::[^=]+)?=)\s*(?:\{|satisfies)?[\s\S]{0,400}?\}/.exec(src)?.[0] ?? '';
      const title = /title:\s*['"`]([^'"`]+)['"`]/.exec(meta)?.[1];
      const component = /component:\s*([A-Z]\w*)/.exec(meta)?.[1];
      const stories: StoryInfo['stories'] = [];
      for (const m of src.matchAll(/export\s+const\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*([\s\S]*?)(?=\nexport\s|$)/g)) {
        const args = /args:\s*(\{[^}]*\})/.exec(m[2]!)?.[1]?.replace(/\s+/g, ' ');
        stories.push({ name: m[1]!, args });
      }
      out.push({ file: relative(root, f), title, component: component ?? title?.split('/').pop(), stories });
    }
  }
  return out;
}

// ---------------- Component guide (FR-305) ----------------

const RAW_FOR: Record<string, string> = {
  button: '<button>',
  card: 'a bordered <div>/<section>',
  input: '<input>',
  textfield: '<input>',
  select: '<select>',
  table: '<table>',
  badge: 'a styled <span>',
  pill: 'a styled <span>',
  tag: 'a styled <span>',
  chip: 'a styled <span>',
  modal: 'a fixed-position <div>',
  dialog: 'a fixed-position <div>',
  tooltip: 'a title attribute or custom popover',
  link: '<a>',
  avatar: 'a round <img>',
  spinner: 'a CSS animation',
  alert: 'a colored <div>',
};

function propsOf(src: string, name: string): string[] {
  const iface = new RegExp(`(?:interface|type)\\s+${name}Props\\s*=?\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1];
  const inline = new RegExp(`(?:function|const)\\s+${name}\\s*(?:=\\s*)?\\(\\s*\\{([^}]*)\\}\\s*:\\s*\\{([^}]*)\\}`).exec(src);
  const body = iface ?? inline?.[2] ?? '';
  return [...body.matchAll(/(\w+)(\?)?\s*:\s*([^;\n]+)/g)].map((m) => `${m[1]}${m[2] ?? ''}: ${m[3]!.trim().replace(/[;,]$/, '')}`);
}

export interface GuideEntry {
  name: string;
  package: string;
  importLine: string;
  props: string[];
  uses: number;
  deprecated: boolean;
  stories: string[];
  instead?: string;
}

/** Which design-system component to use for which job, with imports, props, stories and do/don't. */
export function componentGuide(root: string, hint: string[] = []): { entries: GuideEntry[]; local: { name: string; file: string; uses: number }[]; markdown: string } {
  const ds = designSystem(root, hint);
  const product = files(root, /\.(m?[jt]sx?|vue|svelte)$/).filter((f) => !/\.(test|spec|stories)\./.test(f));
  const sources = product.map((f) => readFileSync(f, 'utf8'));
  const req = createRequire(join(root, 'package.json'));
  const dsDirs: string[] = [];
  const entries: GuideEntry[] = [];
  for (const pkg of ds.packages) {
    let dir = '';
    try {
      dir = dirname(req.resolve(`${pkg}/package.json`));
    } catch {
      dir = join(root, 'node_modules', ...pkg.split('/'));
    }
    dsDirs.push(dir);
    const dsSrc = files(join(dir, 'src'), /\.(m?[jt]sx?)$/).concat(files(dir, /^index\.(m?[jt]sx?)$/, [], 0)).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const name of ds.components[pkg]!) {
      const uses = sources.reduce((n, s) => n + (s.match(new RegExp(`<${name}[\\s/>]`, 'g'))?.length ?? 0), 0);
      const key = Object.keys(RAW_FOR).find((k) => name.toLowerCase().includes(k));
      entries.push({ name, package: pkg, importLine: `import { ${name} } from '${pkg}';`, props: propsOf(dsSrc, name), uses, deprecated: ds.deprecated[pkg]!.includes(name), stories: [], instead: key ? RAW_FOR[key] : undefined });
    }
  }
  for (const s of readStories(root, dsDirs)) {
    const e = entries.find((x) => x.name === s.component);
    if (e) e.stories.push(...s.stories.map((st) => st.name + (st.args ? ` ${st.args}` : '')));
  }
  // App-level shared components (src/components/**) are reusable too.
  const local = files(join(root, 'src', 'components'), /\.(tsx|jsx|vue|svelte)$/).flatMap((f) => {
    const src = readFileSync(f, 'utf8');
    return [...src.matchAll(/export\s+(?:default\s+)?(?:function|const)\s+([A-Z]\w*)/g)].map((m) => ({
      name: m[1]!,
      file: relative(root, f),
      uses: sources.reduce((n, s) => n + (s.match(new RegExp(`<${m[1]}[\\s/>]`, 'g'))?.length ?? 0), 0),
    }));
  });
  const lines = ['# Component guide', '', '_Generated by `npx --no stagecraft guide`. Use these before you write new UI. Regenerate after design-system changes._', ''];
  if (!entries.length) lines.push('No design-system package found. Add its name with `npx --no stagecraft guide --ds <package>`.', '');
  for (const pkg of ds.packages) {
    lines.push(`## ${pkg}`, '');
    for (const e of entries.filter((x) => x.package === pkg).sort((a, b) => Number(a.deprecated) - Number(b.deprecated) || b.uses - a.uses)) {
      lines.push(`### ${e.name}${e.deprecated ? ' (deprecated: do not use)' : ''}`, '', '```ts', e.importLine, '```');
      if (e.props.length) lines.push(`Props: ${e.props.map((p) => `\`${p}\``).join(', ')}`);
      lines.push(`Used ${e.uses} time${e.uses === 1 ? '' : 's'} in this repo.${e.stories.length ? ` Stories: ${e.stories.map((s) => s.split(' ')[0]).join(', ')}.` : ''}`);
      if (e.deprecated) lines.push(`- **Don't** use ${e.name} in new code.`);
      else {
        lines.push(`- **Do** use \`<${e.name}>\` from \`${pkg}\`.`);
        if (e.instead) lines.push(`- **Don't** build ${e.instead} with your own styles for this.`);
      }
      lines.push('');
    }
  }
  if (local.length) {
    lines.push('## App components', '', 'Shared components in this repo. Reuse before you create a new one.', '');
    for (const l of local.sort((a, b) => b.uses - a.uses)) lines.push(`- \`${l.name}\` (\`${l.file}\`), used ${l.uses}×`);
    lines.push('');
  }
  lines.push('## Rules', '', '- Colors, spacing and type come from design tokens, never raw values.', '- Extend a design-system component (props, composition) before you create a new one.', '- If nothing fits, say so in the PR: it is design-system work.', '');
  return { entries, local, markdown: lines.join('\n') };
}

// ---------------- State discovery (FR-109) ----------------

export interface StateProposal {
  entity: string;
  field: string;
  states: string[];
  source: string;
  kind: 'union' | 'enum' | 'flag' | 'story' | 'branch';
  inCatalog: string[];
}

/** Propose product states from code: union/enum status fields, flags, Storybook stories, empty/error branches. */
export function discoverStates(root: string, catalog: Record<string, { states: Record<string, unknown> }> = {}): StateProposal[] {
  const out: StateProposal[] = [];
  const known = new Set(Object.values(catalog).flatMap((d) => Object.keys(d.states)));
  const add = (p: Omit<StateProposal, 'inCatalog'>) => {
    const key = `${p.entity}.${p.field}`;
    const ex = out.find((x) => `${x.entity}.${x.field}` === key);
    if (ex) {
      ex.states = [...new Set([...ex.states, ...p.states])];
      return;
    }
    out.push({ ...p, inCatalog: [] });
  };
  const FIELD = /^(status|state|phase|stage|role|plan|tier|kind|type|mode|level|visibility)$|Status$|State$/;
  for (const f of files(root, /\.(m?[jt]sx?)$/).filter((x) => !/\.(test|spec)\./.test(x))) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(root, f);
    // interface Account { status: 'active' | 'frozen' } / type X = { ... }
    for (const block of src.matchAll(/(?:interface\s+(\w+)|type\s+(\w+)\s*=)\s*\{([\s\S]*?)\n?\}/g)) {
      const entity = (block[1] ?? block[2])!;
      for (const m of block[3]!.matchAll(/(\w+)\??\s*:\s*((?:'[^']+'|"[^"]+")(?:\s*\|\s*(?:'[^']+'|"[^"]+"))+)/g)) {
        if (!FIELD.test(m[1]!)) continue;
        add({ entity: entity[0]!.toLowerCase() + entity.slice(1), field: m[1]!, states: [...m[2]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!), source: `${rel}:${lineOf(src, block.index! + block[0].indexOf(m[0]))}`, kind: 'union' });
      }
    }
    // inline: status: 'active' as 'active' | 'frozen'
    for (const m of src.matchAll(/(\w+)\s*:\s*['"][^'"]+['"]\s+as\s+((?:'[^']+'|"[^"]+")(?:\s*\|\s*(?:'[^']+'|"[^"]+"))+)/g)) {
      if (FIELD.test(m[1]!)) add({ entity: 'unknown', field: m[1]!, states: [...m[2]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!), source: `${rel}:${lineOf(src, m.index!)}`, kind: 'union' });
    }
    for (const m of src.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
      const vals = [...m[2]!.matchAll(/(\w+)\s*(?:=\s*['"]([^'"]+)['"])?/g)].map((x) => x[2] ?? x[1]!).filter(Boolean);
      add({ entity: m[1]![0]!.toLowerCase() + m[1]!.slice(1), field: 'value', states: vals, source: `${rel}:${lineOf(src, m.index!)}`, kind: 'enum' });
    }
    for (const m of src.matchAll(/\b(?:useFlag|variation|getFeatureValue|isOn|isEnabled|getBooleanValue|getStringValue|useBooleanFlagValue|useStringFlagValue|useFeatureIsOn)\(\s*['"]([\w.-]+)['"]/g)) {
      add({ entity: 'flags', field: m[1]!, states: ['on', 'off'], source: `${rel}:${lineOf(src, m.index!)}`, kind: 'flag' });
    }
    if (/\.(tsx|jsx)$/.test(f)) {
      const comp = /export\s+(?:default\s+)?function\s+([A-Z]\w*)/.exec(src)?.[1];
      const branches: string[] = [];
      if (/\.length\s*===\s*0|!\w+\.length|length\s*<\s*1/.test(src)) branches.push('empty');
      if (/\b(?:error|isError)\s*(?:&&|\?)|if\s*\(\s*(?:error|isError)\b/.test(src)) branches.push('error');
      if (/\b(?:loading|isLoading|isPending)\s*(?:&&|\?)|if\s*\(\s*!?\s*(?:loading|isLoading|data)\b/.test(src)) branches.push('loading');
      if (comp && branches.length) add({ entity: `screen:${comp}`, field: 'view', states: branches, source: rel, kind: 'branch' });
    }
  }
  for (const s of readStories(root)) {
    const st = s.stories.map((x) => x.name).filter((n) => /disabled|loading|error|empty|long|overflow|selected|active|invalid|success/i.test(n));
    if (st.length) add({ entity: `component:${s.component ?? s.file}`, field: 'story', states: st.map((n) => n[0]!.toLowerCase() + n.slice(1)), source: s.file, kind: 'story' });
  }
  for (const p of out) p.inCatalog = p.states.filter((x) => known.has(x));
  return out;
}

export function proposedStatesFile(props: StateProposal[]): string {
  const lines = [
    '// PROPOSED states from `npx --no stagecraft discover`. Review: keep, rename or delete each one,',
    '// fill in the db patch, then move what you keep into stagecraft/states.ts.',
    "import { defineStates } from '@stagecraft/core';",
    '',
    'export const proposed = defineStates({',
  ];
  for (const p of props.filter((x) => x.kind === 'union' || x.kind === 'enum')) {
    const name = `${p.entity}_${p.field}`.replace(/[^\w]/g, '_');
    lines.push(`  // from ${p.source}`, `  ${name}: {`, `    label: '${p.entity} ${p.field}',`, `    default: '${p.states[0]}',`, '    states: {');
    for (const s of p.states) lines.push(`      '${s}': { label: '${s.replace(/'/g, "\\'")}', db: { /* TODO: e.g. '${p.entity}.${p.field}': '${s.replace(/'/g, "\\'")}' */ } },`);
    lines.push('    },', '  },');
  }
  lines.push('});', '');
  return lines.join('\n');
}

// ---------------- Setup report (FR-105) ----------------

export async function setupReport(cwd: string): Promise<{ markdown: string; json: any }> {
  const file = findConfig(cwd);
  const root = file ? dirname(file) : cwd;
  const d = detect(root);
  const doc = await doctor(root);
  const engine = file ? await new Engine(file, { log: () => {} }).init().catch(() => null) : null;
  const handlers = engine ? engine.routes.map((r) => r.key) : [];
  let runtimeUnmocked: string[] = [];
  if (engine) {
    const base = `http://127.0.0.1:${engine.config.port}`;
    const eps = await fetch(`${base}/__stagecraft/api/endpoints`).then((r) => r.json(), () => null);
    if (eps) runtimeUnmocked = eps.unmocked.map((u: any) => u.endpoint);
  }
  const prefixes = engine ? engine.config.apiOrigins.filter((o) => o.startsWith('/')) : ['/api'];
  const staticEndpoints = [...new Set(files(join(root, 'src'), /\.(m?[jt]sx?|vue|svelte)$/).flatMap((f) => scanEndpoints(readFileSync(f, 'utf8'), prefixes)))];
  const spec: string[] = [];
  if (engine) {
    for (const r of resolveWorkspace(engine.root, engine.config).filter((x) => x.openapi && existsSync(join(x.abs, x.openapi)))) {
      const cov = specCoverage(readOpenApi(join(r.abs, r.openapi!)), engine.routes);
      spec.push(`${r.name}: ${cov.unmocked.length} spec operations with no mock, ${cov.notInSpec.length} mocks not in the spec`);
    }
  }
  const startFile = join(root, 'stagecraft', '.setup-started');
  const started = existsSync(startFile) ? readFileSync(startFile, 'utf8').trim() : null;
  const minutes = started ? Math.round((Date.now() - Date.parse(started)) / 60000) : null;
  // Each problem gets a plain cause and a next action.
  const steps = [
    ...doc.errors.map((m) => ({ ok: false, what: m.split('\n')[0]!, next: m.includes('Run "') ? m.slice(m.indexOf('Run "')) : 'Fix this, then run "npx --no stagecraft doctor".' })),
    ...doc.warnings.map((m) => ({ ok: null, what: m.split('\n')[0]!, next: /Run "[^"]+"/.exec(m)?.[0] ?? 'Check this.' })),
  ];
  const json = { stack: d, handlers, staticEndpoints, runtimeUnmocked, spec, ok: doc.ok, steps, started, minutes };
  const md = [
    '# Stagecraft setup report',
    '',
    `**Stack:** ${d.framework ? `${d.framework.name} ${d.framework.version ?? ''} (Tier ${d.framework.tier})` : 'unknown'} · ${d.bundler ?? 'no bundler found'} · ${d.packageManager ?? 'package manager unknown'}${d.monorepo ? ` · ${d.monorepo.tool}` : ''}`,
    `**Dev:** \`${d.devCommand ?? '?'}\` on port ${d.devPort ?? '?'} · Node ${d.node ?? 'any'} · router ${d.router ?? 'none found'} · API ${d.apiStyle.join(', ')}${d.flagVendor.length ? ` · flags ${d.flagVendor.join(', ')}` : ''}${d.storybook ? ' · Storybook' : ''}`,
    minutes !== null ? `**Time since setup started:** ${minutes} min` : '',
    '',
    `## Mocked endpoints (${handlers.length})`,
    handlers.map((h) => `- \`${h}\``).join('\n') || '_None yet._',
    '',
    '## Endpoints with no mock',
    [...runtimeUnmocked.map((u) => `- \`${u}\` (called by the app)`), ...doc.warnings.filter((w) => w.startsWith('Endpoints in code')).flatMap((w) => w.split('\n').slice(1).map((l) => `- \`${l.trim()}\` (found in code)`))].join('\n') || '_None found._',
    spec.length ? `\n## API contract\n${spec.map((s) => `- ${s}`).join('\n')}` : '',
    '',
    '## What works',
    doc.ok.map((m) => `- ✅ ${m}`).join('\n'),
    '',
    '## What needs attention',
    steps.length ? steps.map((s) => `- ${s.ok === false ? '❌' : '⚠️'} ${s.what}\n  - Next: ${s.next}`).join('\n') : '_Nothing._',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return { markdown: md + '\n', json };
}

export async function discoverCommand(cmd: string, cwd: string, args: string[], log: (m: string) => void): Promise<number> {
  const file = findConfig(cwd);
  const root = file ? dirname(file) : cwd;
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
    log(`wrote ${rel}`);
  };
  if (cmd === 'guide') {
    const dsArg = args.indexOf('--ds');
    const g = componentGuide(root, dsArg >= 0 ? args[dsArg + 1]!.split(',') : []);
    write('stagecraft/component-guide.md', g.markdown);
    log(`${g.entries.length} design-system components, ${g.local.length} app components.`);
    return 0;
  }
  if (cmd === 'discover') {
    const engine = file ? await new Engine(file, { log: () => {} }).init().catch(() => null) : null;
    const props = discoverStates(root, engine?.config.states ?? {});
    for (const p of props) log(`${p.kind.padEnd(6)} ${p.entity}.${p.field}: ${p.states.join(', ')}  (${p.source})${p.inCatalog.length ? `  in catalog: ${p.inCatalog.join(', ')}` : ''}`);
    if (args.includes('--write')) write('stagecraft/states.proposed.ts', proposedStatesFile(props));
    if (args.includes('--json')) log(JSON.stringify(props, null, 2));
    return 0;
  }
  if (cmd === 'report') {
    const r = await setupReport(cwd);
    if (args.includes('--json')) log(JSON.stringify(r.json, null, 2));
    else {
      write('stagecraft/setup-report.md', r.markdown);
      log(r.markdown);
    }
    return r.json.steps.some((s: any) => s.ok === false) ? 1 : 0;
  }
  return 1;
}
