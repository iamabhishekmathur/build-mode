#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, runTask } from './harness.ts';
import { report } from './report.ts';
import { TASKS } from './tasks.ts';
import type { TaskResult } from './types.ts';

const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (process.argv.includes('--list')) {
  for (const t of TASKS) console.log(`${t.id}  ${t.category.padEnd(10)} ${t.title}`);
  process.exit(0);
}
const tasks = ids.length ? TASKS.filter((t) => ids.includes(t.id)) : TASKS;
const outDir = join(REPO, 'evals/results', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
mkdirSync(outDir, { recursive: true });
const results: TaskResult[] = [];
for (const t of tasks) {
  try {
    results.push(await runTask(t, outDir, console.log));
  } catch (e) {
    console.error(`[${t.id}] harness error: ${(e as Error).stack}`);
  }
  writeFileSync(join(outDir, 'report.md'), report(results, outDir));
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(`\nReport: ${join(outDir, 'report.md')}`);
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.taskId} ${r.checks.filter((c) => c.pass).length}/${r.checks.length} $${(r.agent.costUsd ?? 0).toFixed(2)}`);
