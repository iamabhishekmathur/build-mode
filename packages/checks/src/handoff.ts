import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Engine, findConfig, readOpenApi, resolveWorkspace, specCoverage } from '@stagecraft/server';
import { checkComponents } from './components.ts';
import { checkFast } from './fast.ts';
import { changedFiles, pkgJson, result, type CheckResult, type Finding } from './util.ts';

function productFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const e of existsSync(dir) ? readdirSync(dir) : []) {
    if (['node_modules', 'stagecraft', 'dist', 'build', '.next', 'coverage'].includes(e) || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) productFiles(root, p, out);
    else if (/\.(m?[jt]sx?|vue|svelte)$/.test(e) && !/\.(test|spec|stories)\./.test(e) && !/^stagecraft\.config\./.test(e)) out.push(relative(root, p));
  }
  return out;
}

const VARIANT_USE = /<Variant[\s>]|\buseVariant\s*\(|\bvariant\s*\(\s*['"]/;

function runScript(root: string, script: string, timeoutMs: number): { ok: boolean; out: string } {
  const r = spawnSync('npm', ['run', script, '--silent'], { cwd: root, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CI: '1', STAGECRAFT: '' } });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-1500) };
}

export interface HandoffOptions {
  skipBuild?: boolean;
  skipTests?: boolean;
  timeoutMs?: number;
}

/**
 * FR-1106 handoff gate: build, types, lint, tests, no mock code in product code,
 * no variants left (FR-408), components clean or explained. Each failure says why.
 */
export async function checkHandoff(root: string, opts: HandoffOptions = {}): Promise<CheckResult & { steps: { step: string; ok: boolean; detail?: string }[] }> {
  const t0 = Date.now();
  const steps: { step: string; ok: boolean; detail?: string }[] = [];
  const findings: Finding[] = [];
  const pkg = pkgJson(root);
  const timeout = opts.timeoutMs ?? 5 * 60_000;

  if (!opts.skipBuild && pkg.scripts?.build) {
    const r = runScript(root, 'build', timeout);
    steps.push({ step: 'build', ok: r.ok, detail: r.ok ? undefined : r.out });
    if (!r.ok) findings.push({ rule: 'build', severity: 'error', message: `npm run build failed:\n${r.out}` });
  } else steps.push({ step: 'build', ok: true, detail: opts.skipBuild ? 'skipped' : 'no build script' });

  const fast = checkFast(root, { files: productFiles(root) });
  const fastErrors = fast.findings.filter((f) => f.severity === 'error');
  steps.push({ step: 'types + lint', ok: !fastErrors.length, detail: fastErrors.slice(0, 5).map((f) => `${f.file}:${f.line} ${f.message}`).join('\n') || fast.notes?.join(' ') });
  findings.push(...fastErrors);

  const testScript = pkg.scripts?.test;
  if (!opts.skipTests && testScript && !/no test specified/.test(testScript)) {
    const r = runScript(root, 'test', timeout);
    steps.push({ step: 'tests', ok: r.ok, detail: r.ok ? undefined : r.out });
    if (!r.ok) findings.push({ rule: 'tests', severity: 'error', message: `npm test failed:\n${r.out}` });
  } else steps.push({ step: 'tests', ok: true, detail: opts.skipTests ? 'skipped' : 'no test script' });

  const files = productFiles(root);
  const leaks: Finding[] = [];
  const variants: Finding[] = [];
  for (const f of files) {
    const lines = readFileSync(join(root, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/from\s+['"][./]*stagecraft\/|import\(\s*['"][./]*stagecraft\//.test(l)) leaks.push({ rule: 'mock-leak', severity: 'error', message: 'Product code imports mock code from stagecraft/.', file: f, line: i + 1 });
      if (VARIANT_USE.test(l)) variants.push({ rule: 'variant-left', severity: 'error', message: 'Variant still in the code. Keep the chosen option and remove the wrapper (FR-408).', file: f, line: i + 1 });
    });
  }
  steps.push({ step: 'no mock code in product code', ok: !leaks.length, detail: leaks.map((x) => `${x.file}:${x.line}`).join(', ') || undefined });
  steps.push({ step: 'no variants left', ok: !variants.length, detail: variants.map((x) => `${x.file}:${x.line}`).join(', ') || undefined });
  findings.push(...leaks, ...variants);

  const comp = checkComponents(root);
  const compErr = comp.findings.filter((f) => f.severity === 'error');
  steps.push({ step: 'components clean or explained', ok: !compErr.length, detail: compErr.slice(0, 8).map((f) => `${f.file}:${f.line} ${f.message}`).join('\n') || undefined });
  findings.push(...compErr);

  return { ...result('handoff', t0, findings, { notes: comp.notes }), steps };
}

/** FR-1107: PR description with every section a reviewer needs. */
export async function describePr(root: string, opts: { gate?: Awaited<ReturnType<typeof checkHandoff>>; title?: string } = {}): Promise<string> {
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout ?? '';
  let base = '';
  for (const b of ['main', 'master']) {
    base = git(['merge-base', 'HEAD', b]).trim();
    if (base) break;
  }
  const commits = base ? git(['log', '--format=%s', `${base}..HEAD`]).split('\n').filter(Boolean) : [];
  const changed = changedFiles(root);
  const product = changed.filter((f) => !f.startsWith('stagecraft/') && /\.(m?[jt]sx?|vue|svelte|css|scss)$/.test(f));
  const routeOf = (f: string) => {
    const m = /(?:^|\/)(?:app|pages)\/(.+?)(?:\/page|\/index)?\.(?:[jt]sx?|vue|svelte)$/.exec(f);
    return m ? '/' + m[1]!.replace(/\(.*?\)\/?/g, '').replace(/\/?index$/, '').replace(/^page$/, '') : null;
  };
  const file = findConfig(root);
  const engine = file ? await new Engine(file, { log: () => {} }).init() : null;
  const scenarios = engine ? engine.listScenarios() : [];
  const tapes = engine ? engine.listTapes() : [];
  const states = engine ? Object.entries(engine.config.states ?? {}).map(([e, d]) => `- **${d.label ?? e}**: ${Object.entries(d.states).map(([k, s]) => s.label ?? k).join(', ')}`) : [];
  const figma = new Set<string>();
  for (const f of [...changed, ...scenarios.map((s) => s.file)]) {
    const p = join(root, f);
    if (existsSync(p)) for (const m of readFileSync(p, 'utf8').matchAll(/https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/[^\s"')]+/g)) figma.add(m[0]);
  }
  const backend: string[] = [];
  if (engine) {
    const specs = resolveWorkspace(engine.root, engine.config).filter((r) => r.openapi && existsSync(join(r.abs, r.openapi)));
    if (specs.length) {
      for (const s of specs) {
        const cov = specCoverage(readOpenApi(join(s.abs, s.openapi!)), engine.routes);
        backend.push(...cov.notInSpec.map((k) => `- \`${k}\` is mocked but not in the ${s.name} API spec: **backend must build it**`));
      }
    } else backend.push(...engine.routes.map((r) => `- \`${r.key}\` (mocked; no API spec to compare against)`));
  }
  let openFeedback: string[] = [];
  const fbFile = join(root, '.stagecraft-cache/feedback/feedback.json');
  if (existsSync(fbFile)) openFeedback = JSON.parse(readFileSync(fbFile, 'utf8')).filter((c: any) => !['resolved', 'wont_fix'].includes(c.status)).map((c: any) => `- ${c.text} (${c.status}, ${c.url})`);
  const gate = opts.gate;
  const routes = [...new Set(product.map(routeOf).filter(Boolean))];
  const lines = [
    `## Summary`,
    commits.length ? commits.map((c) => `- ${c}`).join('\n') : '_Describe the change in one or two sentences._',
    '',
    `## Screens changed`,
    routes.length ? routes.map((r) => `- \`${r || '/'}\``).join('\n') : '_No route files changed; see files below._',
    product.length ? `\n<details><summary>${product.length} product files</summary>\n\n${product.map((f) => `- \`${f}\``).join('\n')}\n</details>` : '',
    '',
    `## States covered`,
    states.join('\n') || '_No state catalog._',
    '',
    `## Scenarios`,
    scenarios.length ? scenarios.map((s) => `- **${s.name}**${s.description ? `: ${s.description}` : ''} (\`${s.file}\`)${s.url ? `, opens \`${s.url}\`` : ''}`).join('\n') : '_None._',
    '',
    `## Tapes`,
    tapes.length ? tapes.map((t) => `- **${t.title}** (\`${t.id}\`)`).join('\n') : '_None._',
    '',
    `## Figma`,
    figma.size ? [...figma].map((u) => `- ${u}`).join('\n') : '_No Figma links found._',
    '',
    `## Backend work needed`,
    backend.join('\n') || '_None: every mocked endpoint exists in the API spec._',
    '',
    `## Known gaps`,
    [...openFeedback, ...(gate ? gate.findings.filter((f) => f.severity === 'warning').slice(0, 10).map((f) => `- ${f.message}${f.file ? ` (${f.file}:${f.line})` : ''}`) : [])].join('\n') || '_None known._',
    '',
    `## Handoff gate`,
    gate ? gate.steps.map((s) => `- ${s.ok ? '✅' : '❌'} ${s.step}${s.detail && !s.ok ? `: ${s.detail.split('\n')[0]}` : ''}`).join('\n') : '_Not run. Run `npx --no stagecraft check handoff`._',
    '',
    '_Prototype made with Stagecraft on mock data. Mock code lives in `stagecraft/` and is not part of the production build._',
  ];
  return lines.join('\n') + '\n';
}
