import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findConfig, loadConfig, settle } from '@stagecraft/server';
import { doctor } from 'stagecraft';
import type { EvalTask, TaskContext } from './tasks.ts';
import type { AgentMetrics, CheckResult, TaskResult } from './types.ts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(REPO, 'packages/cli/src/bin.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STAGECRAFT_FILES = ['stagecraft.config.ts', 'stagecraft', '.env.stagecraft', '.mcp.json', '.cursor', '.claude', '.agents', '.codex', 'CLAUDE.md', 'stagecraft.detect.json', 'stagecraft.code-workspace'];

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.email=eval@local', '-c', 'user.name=eval', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Copy the fixture repos into a fresh folder. Each one becomes its own git repo, like a customer's checkout. */
export function prepare(task: EvalTask, dir: string): { repos: Record<string, string>; host: string } {
  mkdirSync(dir, { recursive: true });
  const repos: Record<string, string> = {};
  const skip = (src: string) => !/(^|\/)(node_modules|\.next|\.stagecraft-cache|dist)(\/|$)/.test(src);
  if (task.fixture === 'multi-repo') {
    for (const n of ['acme-web', 'acme-ui', 'acme-admin', 'acme-api']) {
      cpSync(join(REPO, 'examples/multi-repo', n), join(dir, n), { recursive: true, filter: skip });
      repos[n] = join(dir, n);
    }
  } else {
    cpSync(join(REPO, 'examples', task.fixture), join(dir, task.fixture), { recursive: true, filter: skip });
    repos[task.fixture] = join(dir, task.fixture);
  }
  const host = task.fixture === 'multi-repo' ? repos['acme-web']! : repos[task.fixture]!;
  const nextCfg = join(host, 'next.config.mjs');
  if (existsSync(nextCfg)) writeFileSync(nextCfg, readFileSync(nextCfg, 'utf8').replace("join(here, '../..')", JSON.stringify(REPO)));
  if (task.strip) {
    for (const f of STAGECRAFT_FILES) rmSync(join(host, f), { recursive: true, force: true });
    const agents = join(host, 'AGENTS.md');
    if (existsSync(agents)) {
      const t = readFileSync(agents, 'utf8').replace(/<!-- stagecraft:begin[\s\S]*?<!-- stagecraft:end -->\n?/, '').trim();
      if (t) writeFileSync(agents, t + '\n');
      else rmSync(agents);
    }
  }
  task.transform?.(repos, host);
  for (const [, d] of Object.entries(repos)) {
    // Local CLI so `npx --no stagecraft` resolves without a download.
    mkdirSync(join(d, 'node_modules/.bin'), { recursive: true });
    symlinkSync(join(REPO, 'node_modules/.bin/stagecraft'), join(d, 'node_modules/.bin/stagecraft'));
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', 'customer repo');
  }
  if (task.strip) execFileSync('node', [CLI, 'init'], { cwd: host, stdio: 'pipe' });
  // Linked libraries (multi-repo) and agent files must be in place before the agent starts.
  execFileSync('node', [CLI, 'agents', 'sync'], { cwd: host, stdio: 'pipe' });
  if (task.fixture === 'multi-repo') execFileSync('node', [CLI, 'workspace', 'link'], { cwd: host, stdio: 'pipe' });
  return { repos, host };
}

/** `stagecraft dev` in its own process group. */
export async function startDev(host: string, log: string[]): Promise<{ proc: ChildProcess; base: string; stop: () => Promise<void> }> {
  const { config } = await loadConfig(findConfig(host)!);
  const base = `http://127.0.0.1:${config.port}`;
  const proc = spawn('node', [CLI, 'dev'], { cwd: host, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => log.push(String(d)));
  proc.stderr!.on('data', (d) => log.push(String(d)));
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    if (log.join('').includes('[stagecraft] Ready:')) break;
    if (proc.exitCode !== null) throw new Error(`stagecraft dev exited:\n${log.join('').slice(-2000)}`);
    await sleep(300);
  }
  const stop = async () => {
    try {
      process.kill(-proc.pid!, 'SIGTERM');
    } catch {
      /* gone */
    }
    await sleep(1500);
    try {
      process.kill(-proc.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  };
  return { proc, base, stop };
}

const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill', 'TodoWrite', 'mcp__stagecraft', 'Bash(npx --no stagecraft:*)', 'Bash(npx tsc:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)'];

/** Run Claude Code headless with the repo's own generated settings and MCP config. */
export async function runClaude(task: EvalTask, host: string, outFile: string): Promise<AgentMetrics> {
  const t0 = Date.now();
  const args = ['-p', task.prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', ...ALLOWED_TOOLS];
  const proc = spawn('claude', args, { cwd: host, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  let buf = '';
  proc.stdout!.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop()!;
    lines.push(...parts.filter(Boolean));
  });
  let stderr = '';
  proc.stderr!.on('data', (d) => (stderr += d));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
  }, task.timeoutMin * 60_000);
  await new Promise((r) => proc.on('exit', r));
  clearTimeout(timer);
  if (buf) lines.push(buf);
  writeFileSync(outFile, lines.join('\n') + '\n');
  const m: AgentMetrics = { ok: false, turns: null, costUsd: null, durationMs: Date.now() - t0, toolCalls: 0, toolsUsed: {}, skillsUsed: [], screenshots: 0, permissionDenials: [], mcpConnected: false, finalMessage: stderr.slice(-500), timedOut };
  for (const l of lines) {
    let e: any;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === 'system' && e.subtype === 'init') m.mcpConnected = (e.mcp_servers ?? []).some((s: any) => s.name === 'stagecraft' && s.status === 'connected');
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type !== 'tool_use') continue;
        m.toolCalls++;
        m.toolsUsed[c.name] = (m.toolsUsed[c.name] ?? 0) + 1;
        if (c.name === 'Skill') m.skillsUsed.push(String(c.input?.skill));
        if (c.name === 'mcp__stagecraft__preview_screenshot') m.screenshots++;
      }
    }
    if (e.type === 'result') {
      m.ok = e.subtype === 'success' && !e.is_error;
      m.turns = e.num_turns ?? null;
      m.costUsd = e.total_cost_usd ?? null;
      m.finalMessage = String(e.result ?? '').slice(0, 4000);
      m.permissionDenials = (e.permission_denials ?? []).map((d: any) => `${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 160)}`);
    }
  }
  return m;
}

function changed(repos: Record<string, string>) {
  const out: Record<string, string[]> = {};
  const branches: Record<string, string> = {};
  for (const [n, d] of Object.entries(repos)) {
    out[n] = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: d, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3))
      .filter((f) => !f.startsWith('node_modules/') && !f.startsWith('.next/') && !f.startsWith('.stagecraft-cache/') && f !== 'next-env.d.ts');
    // Count committed work on a prototype branch too.
    try {
      const committed = git(d, 'diff', '--name-only', 'main...HEAD').split('\n').filter(Boolean);
      out[n] = [...new Set([...out[n]!, ...committed])];
    } catch {
      /* no main */
    }
    branches[n] = git(d, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  }
  return { files: out, branches };
}

/** Run one task end to end: prepare → start → agent → restart → checks. */
export async function runTask(task: EvalTask, outDir: string, log: (m: string) => void): Promise<TaskResult> {
  const startedAt = new Date().toISOString();
  const work = join(REPO, 'tests/.tmp/evals', `${task.id}-${Date.now().toString(36)}`);
  const taskOut = join(outDir, task.id);
  mkdirSync(taskOut, { recursive: true });
  log(`[${task.id}] prepare in ${work}`);
  const { repos, host } = prepare(task, work);
  const devLog: string[] = [];
  let dev = await startDev(host, devLog);
  if (task.before) await task.before({ base: dev.base, host });
  log(`[${task.id}] agent running (timeout ${task.timeoutMin} min)…`);
  // --dry: no agent. Measures what the product does on its own (baseline) and checks the checkers.
  const agent: AgentMetrics = process.argv.includes('--dry')
    ? { ok: true, turns: 0, costUsd: 0, durationMs: 0, toolCalls: 0, toolsUsed: {}, skillsUsed: [], screenshots: 0, permissionDenials: [], mcpConnected: false, finalMessage: '(dry run: no agent)', timedOut: false }
    : await runClaude(task, host, join(taskOut, 'transcript.jsonl'));
  log(`[${task.id}] agent done: ok=${agent.ok} turns=${agent.turns} cost=$${agent.costUsd?.toFixed(2)} ${Math.round(agent.durationMs / 1000)}s`);
  await dev.stop();
  writeFileSync(join(taskOut, 'dev-during-agent.log'), devLog.join(''));

  // Fresh proxy + dev server for checks: no state or unmocked counts left over from the agent's run.
  const checkLog: string[] = [];
  const checks: CheckResult[] = [];
  const screenshots: string[] = [];
  let doctorWarnings: string[] = [];
  const { files: changedFiles, branches } = changed(repos);
  try {
    dev = await startDev(host, checkLog);
  } catch (e) {
    checks.push({ id: 'app starts', pass: false, detail: (e as Error).message.slice(0, 500) });
    return { taskId: task.id, title: task.title, category: task.category, pass: false, checks, agent, changedFiles, doctorWarnings, screenshots, workdir: work, startedAt };
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const visit: TaskContext['visit'] = async (path, opts = {}) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('response', (r) => r.status() >= 500 && !r.headers()['x-stagecraft-fault'] && errors.push(`HTTP ${r.status()} ${r.url()}`));
      const u = new URL(path, dev.base);
      u.searchParams.set('__sc_session', 'fork');
      u.searchParams.set('sc_panel', '0');
      if (opts.scenario) u.searchParams.set('sc_scenario', opts.scenario);
      if (opts.persona || opts.states) {
        const sc = Buffer.from(JSON.stringify({ ...(opts.persona ? { p: opts.persona } : {}), ...(opts.states ? { s: opts.states } : {}) })).toString('base64url');
        u.searchParams.set('__sc', sc);
      }
      const resp = await page.goto(u.href, { waitUntil: 'load', timeout: 60_000 }).catch((e) => (errors.push(String(e)), null));
      await settle(page, { maxMs: 10_000 });
      if (resp && resp.status() >= 400) errors.push(`document HTTP ${resp.status()}`);
      await page.waitForTimeout(800);
      const overlay = await page.locator('vite-error-overlay, nextjs-portal [data-nextjs-dialog]').count();
      if (overlay) errors.push('framework error overlay shown');
      // A failed document (unknown scenario, server error) has no usable content.
      const docFailed = errors.some((e) => e.startsWith('document HTTP'));
      const text = docFailed ? '' : await page.locator('body').innerText().catch(() => '');
      const html = docFailed ? '' : await page.content();
      const shot = join(taskOut, `${path.replace(/[^a-z0-9]+/gi, '_') || 'root'}${opts.scenario ? '-' + opts.scenario : ''}.png`);
      await page.screenshot({ path: shot });
      screenshots.push(shot);
      await page.close();
      return { text, html, errors };
    };
    // Generic checks for every task.
    for (const route of task.routes) {
      const v = await visit(route);
      const ok = !v.errors.length && v.text.trim().length > 20;
      checks.push({ id: `renders ${route}`, pass: ok, detail: ok ? undefined : [...v.errors, v.text.slice(0, 120)].join(' | ').slice(0, 400) });
    }
    const eps = await (await fetch(`${dev.base}/__stagecraft/api/endpoints`)).json();
    checks.push({ id: 'no unmocked API calls', pass: eps.unmocked.length === 0, detail: eps.unmocked.map((u: any) => u.endpoint).join(', ') || undefined });
    const doc = await doctor(host);
    doctorWarnings = doc.warnings;
    checks.push({ id: 'doctor: no errors', pass: doc.errors.length === 0, detail: doc.errors.join(' | ').slice(0, 400) || undefined });
    if (existsSync(join(host, 'tsconfig.json'))) {
      let ok = true;
      let detail = '';
      try {
        execFileSync('npx', ['tsc', '--noEmit', '-p', '.'], { cwd: host, stdio: 'pipe', encoding: 'utf8' });
      } catch (e: any) {
        ok = false;
        detail = String(e.stdout ?? e.message).slice(0, 400);
      }
      checks.push({ id: 'typecheck', pass: ok, detail: detail || undefined });
    }
    const transcript = existsSync(join(taskOut, 'transcript.jsonl')) ? readFileSync(join(taskOut, 'transcript.jsonl'), 'utf8') : '';
    const agentText = transcript
      .split('\n')
      .flatMap((l) => {
        try {
          const e = JSON.parse(l);
          if (e.type === 'assistant') return (e.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text);
          if (e.type === 'result') return [String(e.result ?? '')];
        } catch {
          /* skip */
        }
        return [];
      })
      .join('\n');
    const ctx: TaskContext = { repos, host, base: dev.base, visit, changedFiles, branches, agentText, transcript };
    for (const c of task.checks) {
      try {
        checks.push(await c.run(ctx));
      } catch (e) {
        checks.push({ id: c.id, pass: false, detail: `check threw: ${(e as Error).message}` });
      }
    }
  } finally {
    await browser.close();
    await dev.stop();
    writeFileSync(join(taskOut, 'dev-during-checks.log'), checkLog.join(''));
  }
  const result: TaskResult = { taskId: task.id, title: task.title, category: task.category, pass: checks.every((c) => c.pass), checks, agent, changedFiles, doctorWarnings, screenshots, workdir: work, startedAt };
  writeFileSync(join(taskOut, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}
