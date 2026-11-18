import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveScenario } from '@stagecraft/core';
import { compile, Engine, findConfig, readOpenApi, resolveWorkspace, specCoverage, workspaceStatus } from '@stagecraft/server';
import { drift } from './agents.ts';

export interface DoctorReport {
  errors: string[];
  warnings: string[];
  ok: string[];
}

const CODE = /\.(m?[jt]sx?|vue|svelte)$/;

function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.') || e === 'dist' || e === 'build') continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) files(p, out);
    else if (CODE.test(e)) out.push(p);
  }
  return out;
}

/** Endpoint-looking string literals in product code: '/api/x', `/api/x/${id}`. */
export function scanEndpoints(source: string, prefixes: string[]): string[] {
  const out = new Set<string>();
  const re = /(['"`])(\/[^'"`\s]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const raw = m[2]!.split('?')[0]!;
    if (!prefixes.some((p) => raw === p || raw.startsWith(p.endsWith('/') ? p : p + '/'))) continue;
    out.add(raw.replace(/\$\{[^}]+\}/g, ':param'));
  }
  return [...out];
}

export async function doctor(cwd: string): Promise<DoctorReport> {
  const r: DoctorReport = { errors: [], warnings: [], ok: [] };
  const file = findConfig(cwd);
  if (!file) {
    r.errors.push('No stagecraft.config.ts. Run "npx stagecraft init".');
    return r;
  }
  const warnings: string[] = [];
  let engine: Engine;
  try {
    engine = await new Engine(file, { log: (m) => warnings.push(m) }).init();
  } catch (e) {
    r.errors.push(`Config does not load: ${(e as Error).message}`);
    return r;
  }
  r.warnings.push(...warnings);
  const root = engine.root;
  r.ok.push(`Config loads: ${engine.routes.length} mock handlers, ${Object.keys(engine.config.personas).length} personas, ${Object.keys(engine.config.states ?? {}).length} state entities.`);

  try {
    engine.freshDb(engine.defaultState().states);
    for (const [entity, def] of Object.entries(engine.config.states ?? {})) {
      for (const name of Object.keys(def.states)) engine.freshDb({ ...engine.defaultState().states, [entity]: name });
    }
    r.ok.push('Every state patch applies to the seed.');
  } catch (e) {
    r.errors.push(`State patch fails on the seed: ${(e as Error).message}`);
  }

  for (const sc of Object.values(engine.scenarios)) {
    try {
      const res = resolveScenario(sc.name, engine.scenarios);
      for (const [entity, st] of Object.entries(res.states ?? {})) {
        if (!engine.config.states?.[entity]?.states[st]) throw new Error(`unknown state ${entity}=${st}`);
      }
      if (res.persona && !engine.config.personas[res.persona]) throw new Error(`unknown persona ${res.persona}`);
      for (const k of Object.keys(res.flags ?? {})) if (!engine.config.flags?.[k]) throw new Error(`unknown flag ${k}`);
    } catch (e) {
      r.warnings.push(`Scenario "${sc.name}" is stale: ${(e as Error).message}`);
    }
  }
  r.ok.push(`${Object.keys(engine.scenarios).length} scenarios, ${Object.keys(engine.tapes).length} tapes loaded.`);

  // Unmocked endpoints referenced in product code.
  const prefixes = engine.config.apiOrigins.filter((o) => o.startsWith('/'));
  const product = files(join(root, 'src')).concat(files(join(root, 'app')), files(join(root, 'pages')));
  const tapeRoute = engine.config.tapes ? [compile(engine.config.tapes.endpoint, 1)] : [];
  const unmocked = new Set<string>();
  const leaks: string[] = [];
  for (const f of product) {
    const src = readFileSync(f, 'utf8');
    for (const ep of scanEndpoints(src, prefixes)) {
      // Match both ways: a template segment (:param) can stand for a literal route segment and vice versa.
      const probe = ep.replace(/:param/g, 'x');
      const epRe = new RegExp('^' + ep.split('/').map((p) => (p === ':param' ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '/?$');
      const sample = (key: string) => key.replace(/^\S+\s+/, '').replace(/:[^/]+/g, 'x');
      const hit = [...engine.routes, ...tapeRoute].some((rt) => rt.re.test(probe) || epRe.test(sample(rt.key)));
      if (!hit) unmocked.add(`${ep}  (${relative(root, f)})`);
    }
    if (/from\s+['"][./]*stagecraft\//.test(src) || /import\(['"][./]*stagecraft\//.test(src)) leaks.push(relative(root, f));
  }
  if (unmocked.size) r.warnings.push(`Endpoints in code with no mock:\n    ${[...unmocked].join('\n    ')}`);
  else r.ok.push('Every endpoint string found in product code has a mock.');
  if (leaks.length) r.errors.push(`Product code imports mock code from stagecraft/ (FR-507):\n    ${leaks.join('\n    ')}`);
  else r.ok.push('No product code imports from stagecraft/.');

  // ---------- multi-repo workspace ----------
  const repos = resolveWorkspace(root, engine.config);
  if (repos.length > 1) {
    const st = workspaceStatus(repos);
    for (const x of st) {
      if (!x.present) (x.role === 'library' || x.role === 'app' ? r.errors : r.warnings).push(`Workspace repo "${x.name}" is missing at ${x.path}. Run "npx stagecraft workspace clone".`);
      for (const l of x.links) if (!l.linked) r.warnings.push(`${l.package} is not linked into ${l.consumer}: edits in the library repo will not show. Run "npx stagecraft workspace link" (or "stagecraft dev" links it).`);
    }
    // npm-link style links load the library's own React if it has one: two Reacts break hooks.
    for (const lib of repos.filter((x) => x.role === 'library' && existsSync(x.abs))) {
      const libReact = join(lib.abs, lib.packagePath ?? '.', 'node_modules', 'react');
      if (existsSync(libReact)) {
        r.warnings.push(`${lib.name} has its own node_modules/react. Linked, the apps may load two copies of React. Fix: dedupe react/react-dom in the app bundler (Vite: resolve.dedupe), or remove react from the library's node_modules.`);
      }
    }
    const branches = new Set(st.filter((x) => !x.readOnly && x.changedFiles.length && x.branch).map((x) => x.branch));
    if (branches.size > 1) r.warnings.push(`Changed repos are on different branches (${[...branches].join(', ')}). Run "npx stagecraft workspace branch <name>".`);
    for (const x of st) if (x.readOnly && x.changedFiles.length) r.warnings.push(`Read-only repo "${x.name}" has changes: ${x.changedFiles.slice(0, 5).join(', ')}`);
    if (!r.errors.length) r.ok.push(`Workspace: ${repos.length - 1} repos (${repos.filter((x) => !x.host).map((x) => `${x.name}:${x.role}`).join(', ')}).`);
    // Mocks vs the API contract.
    for (const api of repos.filter((x) => x.openapi)) {
      const spec = join(api.abs, api.openapi!);
      if (!existsSync(spec)) {
        r.warnings.push(`OpenAPI spec not found: ${api.path}/${api.openapi}`);
        continue;
      }
      try {
        const cov = specCoverage(readOpenApi(spec), engine.routes);
        if (cov.unmocked.length) r.warnings.push(`API operations in ${api.name}/${api.openapi} with no mock:\n    ${cov.unmocked.join('\n    ')}`);
        if (cov.notInSpec.length) r.warnings.push(`Mocks for endpoints that are not in the ${api.name} spec (the prototype may rely on an API that does not exist):\n    ${cov.notInSpec.join('\n    ')}`);
        if (!cov.unmocked.length && !cov.notInSpec.length) r.ok.push(`Mocks match the ${api.name} OpenAPI spec.`);
      } catch (e) {
        r.warnings.push(`Could not read ${api.path}/${api.openapi}: ${(e as Error).message}`);
      }
    }
  }

  const d = drift(root, repos);
  if (d.length) r.warnings.push(`Agent files are out of date with stagecraft/agents.md: ${d.join(', ')}. Run "npx stagecraft agents sync".`);
  else r.ok.push('Agent instructions and skills are in sync.');

  if (!existsSync(join(root, '.env.stagecraft'))) r.warnings.push('No .env.stagecraft. The dev server may read real env values.');
  for (const f of ['.env.production', '.env.prod']) {
    if (existsSync(join(root, f))) r.warnings.push(`${f} exists. Stagecraft never loads it; keep it out of prototype sandboxes.`);
  }
  return r;
}
