import { readFileSync } from 'node:fs';
import { checkA11y, checkComponents, checkFast, checkHandoff, checkVisual, describePr, renderMatrix, VIEWPORTS, type Cell, type CheckResult } from '@stagecraft/checks';
import { findConfig, loadConfig } from '@stagecraft/server';

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function proxyBase(cwd: string): Promise<{ base: string; root: string }> {
  const file = findConfig(cwd);
  if (!file) throw new Error('No stagecraft.config.ts');
  const { config, root } = await loadConfig(file);
  const base = process.env.STAGECRAFT_URL ?? `http://127.0.0.1:${config.port}`;
  const ok = await fetch(`${base}/__stagecraft/health`).then((r) => r.ok, () => false);
  if (!ok) throw new Error(`The Stagecraft proxy is not running at ${base}. Start "npx --no stagecraft dev" first.`);
  return { base, root };
}

function cellsFrom(args: string[]): Cell[] | undefined {
  const f = flag(args, '--cells');
  if (f) return JSON.parse(readFileSync(f, 'utf8'));
  const vps = flag(args, '--viewports');
  if (vps) return vps.split(',').map((v) => ({ viewport: (VIEWPORTS as any)[v] ?? { width: Number(v), height: 800 } }));
  return undefined;
}

function print(r: CheckResult, json: boolean, log: (m: string) => void) {
  if (json) return log(JSON.stringify(r, null, 2));
  log(`${r.pass ? '✓' : '✗'} check ${r.check} (${r.ms} ms)`);
  for (const n of r.notes ?? []) log(`  · ${n}`);
  for (const f of r.findings) log(`  ${f.severity === 'error' ? '✗' : '!'} [${f.rule}] ${f.message}${f.file ? `  ${f.file}${f.line ? ':' + f.line : ''}` : ''}${f.where ? `  @ ${f.where}` : ''}${f.selector ? `  (${f.selector})` : ''}`);
  const steps = (r as any).steps as { step: string; ok: boolean; detail?: string }[] | undefined;
  if (steps) for (const s of steps) log(`  ${s.ok ? '✓' : '✗'} ${s.step}${s.detail ? ` — ${s.detail.split('\n')[0]}` : ''}`);
}

export async function checkCommand(cwd: string, kind: string | undefined, args: string[], log: (m: string) => void): Promise<number> {
  const json = args.includes('--json');
  const root = findConfig(cwd) ? (await loadConfig(findConfig(cwd)!)).root : cwd;
  const routes = (flag(args, '--routes') ?? '/').split(',');
  let r: CheckResult;
  switch (kind) {
    case 'fast':
      r = checkFast(root);
      break;
    case 'components':
      r = checkComponents(root);
      break;
    case 'a11y': {
      const { base } = await proxyBase(cwd);
      r = await checkA11y({ base, root, routes, cells: cellsFrom(args) });
      break;
    }
    case 'visual': {
      const { base } = await proxyBase(cwd);
      r = await checkVisual({ base, root, routes, cells: cellsFrom(args) });
      break;
    }
    case 'handoff':
      r = await checkHandoff(root, { skipBuild: args.includes('--skip-build'), skipTests: args.includes('--skip-tests') });
      break;
    default:
      log('Usage: stagecraft check fast | components | a11y [--routes /,/x] | visual [--routes …] [--viewports desktop,phone] [--cells cells.json] | handoff [--skip-build] [--skip-tests]   (--json for machine output)');
      return 1;
  }
  print(r, json, log);
  return r.pass ? 0 : 1;
}

export async function matrixCommand(cwd: string, route: string | undefined, args: string[], log: (m: string) => void): Promise<number> {
  const { base, root } = await proxyBase(cwd);
  const m = await renderMatrix({ base, root, routes: [], route: route ?? '/', cells: cellsFrom(args) });
  log(`${m.cells.length} cells in ${m.ms} ms → ${base}/__stagecraft/checks/${m.dir.split('/').pop()}/index.html`);
  return 0;
}

export async function describeCommand(cwd: string, args: string[], log: (m: string) => void): Promise<number> {
  const root = findConfig(cwd) ? (await loadConfig(findConfig(cwd)!)).root : cwd;
  const gate = args.includes('--gate') ? await checkHandoff(root, { skipBuild: args.includes('--skip-build'), skipTests: args.includes('--skip-tests') }) : undefined;
  log(await describePr(root, { gate }));
  return 0;
}
