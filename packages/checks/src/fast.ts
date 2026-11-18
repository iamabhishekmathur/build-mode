import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { changedFiles, findBin, pkgJson, result, type CheckResult, type Finding } from './util.ts';

/** FR-1003: type check + lint, scoped to changed files where the tool allows. Target ≤ 20 s. */
export function checkFast(root: string, opts: { files?: string[] } = {}): CheckResult {
  const t0 = Date.now();
  const findings: Finding[] = [];
  const notes: string[] = [];
  const files = (opts.files ?? changedFiles(root)).filter((f) => /\.(m?[jt]sx?|vue)$/.test(f));
  if (existsSync(join(root, 'tsconfig.json'))) {
    // tsc needs the whole program to type-check; report only errors in changed files (plus config errors).
    const tsc = findBin(root, 'tsc', 'typescript/bin/tsc');
    const r = tsc ? spawnSync(tsc[0]!, [...tsc.slice(1), '--noEmit', '-p', '.', '--pretty', 'false'], { cwd: root, encoding: 'utf8' }) : { stdout: '', stderr: '', error: new Error('typescript not installed') };
    for (const line of (r.stdout + r.stderr).split('\n')) {
      const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line.trim());
      if (!m) {
        if (/error TS\d+/.test(line)) findings.push({ rule: 'typecheck', severity: 'error', message: line.trim() });
        continue;
      }
      const file = m[1]!.replace(/^\.\//, '');
      if (opts.files === undefined && files.length && !files.includes(file)) continue;
      findings.push({ rule: `typecheck ${m[3]}`, severity: 'error', message: m[4]!, file, line: Number(m[2]) });
    }
    if (r.error) notes.push(`tsc could not run: ${r.error.message}`);
  } else notes.push('No tsconfig.json: type check skipped.');
  const pkg = pkgJson(root);
  const hasEslint = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json'].some((f) => existsSync(join(root, f))) || pkg.eslintConfig;
  if (hasEslint && files.length) {
    const eslint = findBin(root, 'eslint', 'eslint/bin/eslint.js');
    const r = eslint ? spawnSync(eslint[0]!, [...eslint.slice(1), '--format', 'json', ...files], { cwd: root, encoding: 'utf8' }) : { stdout: '', stderr: 'eslint not installed' };
    try {
      for (const f of JSON.parse(r.stdout || '[]')) {
        for (const m of f.messages) findings.push({ rule: `lint ${m.ruleId ?? ''}`.trim(), severity: m.severity === 2 ? 'error' : 'warning', message: m.message, file: f.filePath.replace(root + '/', ''), line: m.line });
      }
    } catch {
      notes.push(`eslint output not readable: ${(r.stderr || r.stdout).slice(0, 200)}`);
    }
  } else notes.push(hasEslint ? 'No changed files to lint.' : 'No ESLint config: lint skipped.');
  return result('fast', t0, findings, { notes });
}
