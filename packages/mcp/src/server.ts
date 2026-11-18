import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateTape } from '@stagecraft/core';
import { registerGithubTools } from '@stagecraft/github';
import { checkA11y, checkComponents, checkFast, checkHandoff, checkVisual, describePr, renderMatrix, VIEWPORTS } from '@stagecraft/checks';
import { readFileSync as readFileSyncFs } from 'node:fs';
import { detect, findConfig, loadConfig, resolveWorkspace, settle, workspaceStatus } from '@stagecraft/server';

/**
 * Tool names use underscores, not the dots in the PRD (`state.set`).
 * The Anthropic and OpenAI APIs only allow [a-zA-Z0-9_-] in tool names.
 */
export interface McpOptions {
  /** Proxy base URL. Default: STAGECRAFT_URL, else http://127.0.0.1:<config port>. */
  baseUrl?: string;
  cwd?: string;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (v: unknown): { content: Content[] } => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true });

export async function resolveBaseUrl(opts: McpOptions): Promise<{ baseUrl: string; root: string | null }> {
  const cwd = opts.cwd ?? process.cwd();
  const file = findConfig(cwd);
  if (opts.baseUrl) return { baseUrl: opts.baseUrl, root: file ? join(file, '..') : null };
  if (process.env.STAGECRAFT_URL) return { baseUrl: process.env.STAGECRAFT_URL, root: file ? join(file, '..') : null };
  if (!file) return { baseUrl: 'http://127.0.0.1:4400', root: null };
  try {
    const { config, root } = await loadConfig(file);
    return { baseUrl: `http://127.0.0.1:${config.port}`, root };
  } catch {
    return { baseUrl: 'http://127.0.0.1:4400', root: join(file, '..') };
  }
}

export async function createMcpServer(opts: McpOptions = {}) {
  const { baseUrl, root } = await resolveBaseUrl(opts);
  const server = new McpServer({ name: 'stagecraft', version: '0.1.0' });

  async function call(method: string, path: string, body?: unknown, session?: string) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/__stagecraft/api${path}`, {
        method,
        // The proxy refuses some actions from agents (e.g. resolving feedback: only people do that).
        headers: { 'content-type': 'application/json', 'x-stagecraft-actor': 'agent', ...(session ? { 'x-stagecraft-session': session } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`Stagecraft proxy is not running at ${baseUrl}. Start it with "npx --no stagecraft dev" in the repo, then retry.`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  const session = z.string().optional().describe('Session id. Default "main" (what the user sees).');
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: any) => {
      try {
        const out = await fn(args);
        return out && typeof out === 'object' && 'content' in (out as object) ? out : text(out);
      } catch (e) {
        return fail((e as Error).message);
      }
    }) as any);

  // GitHub: draft PRs, preview comments, branch-from, ready-for-review behind the gate. No merge tool.
  registerGithubTools(tool as any, { cwd: opts.cwd });

  tool(
    'mocks_generate',
    'Generate typed seed data, a mock handler for every operation, and edge states (empty, one, many 1,200, long text, RTL, unicode) from an OpenAPI spec or exported TypeScript types. Writes stagecraft/generated/ (never edit it; regenerate) and returns the lines to spread into stagecraft/seed.ts, mocks.ts and states.ts.',
    {
      openapi: z.string().optional().describe('OpenAPI 3.x spec (JSON or YAML), relative to the repo'),
      types: z.string().optional().describe('TypeScript file with exported API types'),
      typeMap: z.array(z.string()).optional().describe('With types: "Name:/path", e.g. "Invoice:/v1/invoices" (plural = collection), "Account:/v1/account" (singleton)'),
      out: z.string().optional().describe('Default stagecraft/generated'),
      seed: z.number().int().optional().describe('Default 42; same seed → identical data'),
      count: z.number().int().optional().describe('Rows per collection, default 8'),
    },
    async (a) => {
      const file = findConfig(opts.cwd ?? process.cwd());
      const cwd = file ? dirname(file) : (opts.cwd ?? process.cwd());
      // Dynamic: the CLI package depends on this one.
      const mod = 'stagecraft';
      const { generateMocks } = await import(mod);
      return generateMocks({ cwd, ...a });
    },
  );

  tool('setup_detect', 'Detect the repo stack (framework, package manager, dev command, router, API style, flags, design system, Storybook).', {}, async () => {
    if (!root) throw new Error('No stagecraft.config.ts found. Run "npx --no stagecraft init" first.');
    return detect(root);
  });

  tool(
    'workspace_status',
    'Multi-repo products: every repo (host, apps, libraries, API), its role, branch, changed files and library links. Use it to see which repos a change touched; a handoff is one PR per changed repo.',
    {},
    async () => {
      const file = findConfig(opts.cwd ?? process.cwd());
      if (!file) throw new Error('No stagecraft.config.ts found.');
      const { config, root: r } = await loadConfig(file);
      return workspaceStatus(resolveWorkspace(r, config));
    },
  );

  async function shot(id: string, name?: string): Promise<Content | null> {
    if (!name) return null;
    try {
      const r = await fetch(`${baseUrl}/__stagecraft/api/feedback/${encodeURIComponent(id)}/shot/${encodeURIComponent(name)}.png`);
      if (!r.ok) return null;
      return { type: 'image', data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType: 'image/png' };
    } catch {
      return null;
    }
  }

  tool(
    'feedback_list',
    'Comments people pinned on the prototype (FR-903). Default: the ones sent to you. Each has text, author, page URL, element selector, source file/line when known, persona/states/flags/variants at comment time, and a screenshot with the target outlined. Use scenario/state from the comment to reproduce it.',
    { status: z.string().optional().describe('Comma list: open, sent, agent_done, resolved, wont_fix. Default "sent".'), images: z.boolean().optional().describe('Attach screenshots (default true, max 6)') },
    async (a) => {
      const items: any[] = await call('GET', `/feedback?status=${encodeURIComponent(a.status ?? 'sent')}`);
      const content: Content[] = [{ type: 'text', text: JSON.stringify(items, null, 2) }];
      if (a.images !== false) {
        for (const it of items.slice(0, 6)) {
          const img = await shot(it.id, it.screenshot);
          if (img) content.push({ type: 'text', text: `Screenshot for ${it.id}:` }, img);
        }
      }
      if (!items.length) content[0] = { type: 'text', text: `No feedback with status ${a.status ?? 'sent'}. Ask the person to press "Send to agent" in the Stagecraft panel, or list status "open".` };
      return { content };
    },
  );

  tool(
    'feedback_reply',
    'Reply to a comment after you changed the code: what you changed. Stagecraft takes an "after" screenshot in the comment\'s original state and attaches before/after. Sets status agent_done. You cannot resolve comments; the person does.',
    { id: z.string(), text: z.string(), commit: z.string().optional() },
    async (a) => {
      const fb = await call('POST', `/feedback/${encodeURIComponent(a.id)}/reply`, { text: a.text, commit: a.commit });
      const last = fb.replies[fb.replies.length - 1];
      const content: Content[] = [{ type: 'text', text: JSON.stringify({ id: fb.id, status: fb.status, reply: last }, null, 2) }];
      for (const n of [last.before, last.after]) {
        const img = await shot(fb.id, n);
        if (img) content.push(img);
      }
      return { content };
    },
  );

  const needRoot = () => {
    if (!root) throw new Error('No stagecraft.config.ts found.');
    return root;
  };
  const cellShape = z
    .array(
      z.object({
        label: z.string().optional(),
        persona: z.string().optional(),
        states: z.record(z.string()).optional(),
        scenario: z.string().optional(),
        flags: z.record(z.any()).optional(),
        variants: z.record(z.string()).optional(),
        viewport: z.union([z.enum(['desktop', 'tablet', 'phone']), z.object({ width: z.number(), height: z.number() })]).optional(),
        theme: z.enum(['light', 'dark']).optional(),
      }),
    )
    .optional()
    .describe('State matrix cells. Default: current state on desktop and phone.');
  const cellsOf = (cells?: any[]) => cells?.map((c) => ({ ...c, viewport: typeof c.viewport === 'string' ? (VIEWPORTS as any)[c.viewport] : c.viewport }));
  const png = (file: string): Content => ({ type: 'image', data: readFileSyncFs(file).toString('base64'), mimeType: 'image/png' });

  tool('check_fast', 'Type check + lint on changed files (FR-1003). Run after each edit.', {}, async () => checkFast(needRoot()));

  tool(
    'check_components',
    'Design-system hygiene on changed lines (FR-1005): hard-coded colors/spacing, new components that duplicate design-system ones, deprecated imports. Silence one line with a "stagecraft-allow: <reason>" comment.',
    {},
    async () => checkComponents(needRoot()),
  );

  tool(
    'check_visual',
    'Visual self-check (FR-1001): screenshots routes across a state matrix (deterministic: fixed clock, seeded random) and detects page overflow, cut-off text, overlapping controls, broken images, "undefined"/"NaN" shown, empty pages, low contrast and runtime errors. Returns findings and the screenshots: look at them yourself too.',
    { routes: z.array(z.string()).default(['/']), cells: cellShape, maxImages: z.number().default(6) },
    async (a) => {
      const r = await checkVisual({ base: baseUrl, root: needRoot(), routes: a.routes, cells: cellsOf(a.cells) });
      const content: Content[] = [{ type: 'text', text: JSON.stringify({ pass: r.pass, findings: r.findings, ms: r.ms, cells: r.cells.map((c) => ({ route: c.route, label: c.label, url: c.url })) }, null, 2) }];
      for (const c of r.cells.slice(0, a.maxImages)) content.push({ type: 'text', text: `${c.route} @ ${c.label}` }, png(c.screenshot));
      return { content };
    },
  );

  tool('check_a11y', 'Accessibility scan with axe-core, WCAG 2.2 A/AA (FR-1004). Returns violations with selectors.', { routes: z.array(z.string()).default(['/']), cells: cellShape }, async (a) =>
    checkA11y({ base: baseUrl, root: needRoot(), routes: a.routes, cells: cellsOf(a.cells) }),
  );

  tool(
    'matrix_render',
    'Render one route across a matrix of states × personas × viewports as a grid of screenshots (FR-407). Returns the grid URL (each cell links to its live state) and the images.',
    { route: z.string().default('/'), cells: cellShape, maxImages: z.number().default(8) },
    async (a) => {
      const m = await renderMatrix({ base: baseUrl, root: needRoot(), routes: [], route: a.route, cells: cellsOf(a.cells) });
      const content: Content[] = [{ type: 'text', text: JSON.stringify({ grid: `${baseUrl}/__stagecraft/checks/${m.dir.split('/').pop()}/index.html`, ms: m.ms, cells: m.cells.map((c) => ({ label: c.label, url: c.url })) }, null, 2) }];
      for (const c of m.cells.slice(0, a.maxImages)) content.push({ type: 'text', text: c.label }, png(c.screenshot));
      return { content };
    },
  );

  tool(
    'check_handoff',
    'Handoff gate (FR-1106): build, types, lint, tests, no mock code in product code, no variants left, components clean or explained. Run before "ready for engineering".',
    { skipBuild: z.boolean().optional(), skipTests: z.boolean().optional() },
    async (a) => checkHandoff(needRoot(), { skipBuild: a.skipBuild, skipTests: a.skipTests }),
  );

  tool('pr_describe', 'Write the PR description (FR-1107): summary, screens, states, scenarios, tapes, Figma links, backend work needed, known gaps, gate result.', { runGate: z.boolean().optional() }, async (a) => {
    const r = needRoot();
    return describePr(r, { gate: a.runGate ? await checkHandoff(r, { skipBuild: true }) : undefined });
  });

  tool('session_get', 'Current persona, states, flags, variants, faults, scenario and tape for a session, plus a shareable link.', { session }, (a) => call('GET', '/session', undefined, a.session));

  tool('state_catalog', 'List personas, entity states, flags, variants seen in the page, scenarios, tapes and mocked endpoints.', {}, () => call('GET', '/catalog'));

  tool(
    'state_set',
    'Select product states, e.g. {"account":"frozen"}. Applies the state DB patch. Re-selecting the current state does nothing.',
    { states: z.record(z.string()).describe('entity → state name'), session },
    (a) => call('PATCH', '/session', { states: a.states }, a.session),
  );

  tool('persona_set', 'Switch the signed-in persona (role). The mock DB is kept.', { persona: z.string(), session }, (a) => call('PATCH', '/session', { persona: a.persona }, a.session));

  tool('flags_list', 'Feature flags: definitions and effective values.', { session }, async (a) => {
    const [cat, s] = await Promise.all([call('GET', '/catalog'), call('GET', '/session', undefined, a.session)]);
    return Object.fromEntries(Object.entries(cat.flags).map(([k, def]) => [k, { ...(def as object), value: s.flags[k], overridden: k in s.state.flags }]));
  });

  tool('flags_set', 'Override flags for this prototype session. Use null to clear an override.', { flags: z.record(z.any()), session }, (a) => call('PATCH', '/session', { flags: a.flags }, a.session));

  tool('variant_list', 'Variants registered by <Variant>/useVariant in the page, with the selected option. The page must have rendered them once.', { session }, async (a) => {
    const [cat, s] = await Promise.all([call('GET', '/catalog'), call('GET', '/session', undefined, a.session)]);
    return Object.fromEntries(Object.entries(cat.variants as Record<string, string[]>).map(([k, opts]) => [k, { options: opts, selected: s.state.variants[k] ?? opts[0] }]));
  });

  tool('variant_select', 'Show one option of a variant.', { name: z.string(), option: z.string(), session }, (a) => call('PATCH', '/session', { variants: { [a.name]: a.option } }, a.session));

  tool(
    'scenario_save',
    'Save the current setup (persona, states, flags, variants, faults, mock DB snapshot) to stagecraft/scenarios/<name>.json.',
    { name: z.string(), description: z.string().optional(), url: z.string().optional().describe('Route to open, e.g. /settings/agents'), extends: z.string().optional(), includeDb: z.boolean().optional(), session },
    (a) => call('POST', '/scenarios', { name: a.name, description: a.description, url: a.url, extends: a.extends, includeDb: a.includeDb }, a.session),
  );

  tool('scenario_load', 'Load a saved scenario into the session.', { name: z.string(), session }, (a) => call('POST', '/scenarios/load', { name: a.name }, a.session));

  tool('scenario_list', 'List saved scenarios.', {}, () => call('GET', '/scenarios'));

  tool('mockdb_query', 'Read the mock DB. Path syntax: account.status, users[id=u2].onboardingStep, payments[0].', { path: z.string().optional(), session }, (a) =>
    call('GET', `/mockdb${a.path ? `?path=${encodeURIComponent(a.path)}` : ''}`, undefined, a.session),
  );

  tool(
    'mockdb_seed',
    'Write to the mock DB. `patch` maps paths to values or ops ({"$push":x}, {"$merge":{}}, {"$remove":true}, {"$inc":n}). `replace` swaps the whole DB.',
    { patch: z.record(z.any()).optional(), replace: z.any().optional(), session },
    (a) => call('POST', '/mockdb/seed', { patch: a.patch, replace: a.replace }, a.session),
  );

  tool('mockdb_reset', 'Reset the mock DB to seed + the selected states.', { session }, (a) => call('POST', '/mockdb/reset', undefined, a.session));

  tool('mock_endpoints', 'Mocked endpoints, the tape endpoint, and requests the app made that have no mock yet.', {}, () => call('GET', '/endpoints'));

  tool(
    'fault_set',
    'Replace the fault rules: latency, error status or no response per endpoint. Empty list clears faults.',
    {
      faults: z.array(z.object({ endpoint: z.string().describe('e.g. "GET /api/payments"'), latencyMs: z.number().optional(), status: z.number().optional(), timeout: z.boolean().optional(), body: z.any().optional() })),
      session,
    },
    (a) => call('PATCH', '/session', { faults: a.faults }, a.session),
  );

  tool('tape_validate', 'Validate a tape JSON object. Returns issues with JSON paths.', { tape: z.any() }, async (a) => {
    const issues = validateTape(a.tape);
    return { valid: issues.length === 0, issues };
  });

  tool(
    'tape_create',
    'Validate and save a tape to stagecraft/tapes/<id>.json. Events: user_message, agent_message, tool_call, tool_result, pending_action, state_change, delay, error, timeout, branch. See the make-tape skill.',
    { tape: z.any() },
    (a) => call('POST', '/tapes', { tape: a.tape }),
  );

  tool(
    'tape_play',
    'Load a tape in the session. `at` is a step ("4" or "approved:2"); with `at` the tape pauses there.',
    { id: z.string(), at: z.string().optional(), autoplay: z.boolean().optional(), session },
    (a) => call('POST', '/tape/load', { id: a.id, at: a.at, autoplay: a.autoplay }, a.session),
  );

  tool('tape_control', 'Control the loaded tape: play, pause, step or stop.', { action: z.enum(['play', 'pause', 'step', 'stop']), session }, (a) =>
    call('POST', '/tape/control', { action: a.action }, a.session),
  );

  tool('preview_url', 'URL of the running prototype, and a link that reproduces the current state.', { path: z.string().optional(), session }, async (a) => {
    const s = await call('GET', `/session?path=${encodeURIComponent(a.path ?? '/')}`, undefined, a.session);
    return { baseUrl, link: baseUrl + s.link };
  });

  tool('preview_navigate', 'Navigate the open browser tabs of a session to a route.', { path: z.string(), session }, (a) => call('POST', '/navigate', { url: a.path }, a.session));

  tool(
    'preview_screenshot',
    'Screenshot a route in a forked copy of the session (the user\'s view is not changed). Optionally load a scenario first, and run actions (click, fill, wait) before the shot, e.g. open a drawer or the assistant chat. Works with error states, hung requests and open streams. Returns a PNG.',
    {
      path: z.string().default('/'),
      scenario: z.string().optional(),
      width: z.number().default(1280),
      height: z.number().default(800),
      fullPage: z.boolean().default(false),
      theme: z.enum(['light', 'dark']).optional(),
      actions: z
        .array(
          z.object({
            click: z.string().optional().describe('Text of a button or link, or a CSS selector (prefix "css=")'),
            fill: z.string().optional().describe('Label, placeholder or CSS selector ("css=") of an input'),
            value: z.string().optional(),
            wait: z.number().optional().describe('Milliseconds to wait'),
          }),
        )
        .optional()
        .describe('Steps to run before the screenshot, in order'),
      session,
    },
    async (a) => {
      let chromium;
      try {
        const mod = 'playwright';
        ({ chromium } = (await import(mod)) as typeof import('playwright'));
      } catch {
        throw new Error('Playwright is not installed. Run "npm i -D playwright" and "npx playwright install chromium".');
      }
      const u = new URL(a.path, baseUrl);
      u.searchParams.set('__sc_session', `fork:${a.session ?? 'main'}`);
      u.searchParams.set('sc_panel', '0');
      if (a.scenario) u.searchParams.set('sc_scenario', a.scenario);
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: a.width, height: a.height }, colorScheme: a.theme ?? 'light', reducedMotion: 'reduce' });
        const errors: string[] = [];
        page.on('pageerror', (e: Error) => errors.push(e.message));
        await page.goto(u.href, { waitUntil: 'load' });
        let pending = await settle(page);
        const target = (q: string) => (q.startsWith('css=') ? page.locator(q.slice(4)) : page.getByRole('button', { name: q }).or(page.getByRole('link', { name: q })).or(page.getByText(q, { exact: true })).first());
        const steps: string[] = [];
        for (const act of a.actions ?? []) {
          try {
            if (act.click) await target(act.click).click({ timeout: 5000 });
            else if (act.fill) await (act.fill.startsWith('css=') ? page.locator(act.fill.slice(4)) : page.getByLabel(act.fill).or(page.getByPlaceholder(act.fill)).first()).fill(act.value ?? '', { timeout: 5000 });
            if (act.wait) await page.waitForTimeout(act.wait);
            steps.push(`ok ${JSON.stringify(act)}`);
          } catch (e) {
            steps.push(`FAILED ${JSON.stringify(act)}: ${(e as Error).message.split('\n')[0]}`);
          }
          pending = await settle(page);
        }
        await page.waitForTimeout(150);
        const png = await page.screenshot({ fullPage: a.fullPage, animations: 'disabled' });
        let file: string | undefined;
        if (root) {
          const dir = join(root, '.stagecraft-cache', 'screenshots');
          mkdirSync(dir, { recursive: true });
          file = join(dir, `${Date.now()}-${a.path.replace(/[^a-z0-9]+/gi, '_')}.png`);
          writeFileSync(file, png);
        }
        const info = { url: u.href, file, ...(steps.length ? { actions: steps } : {}), ...(errors.length ? { pageErrors: errors } : {}), ...(pending.length ? { stillLoading: pending } : {}) };
        return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(info) }] };
      } finally {
        await browser.close();
      }
    },
  );

  return { server, baseUrl };
}
