import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect } from '@stagecraft/server';
import { doctor, drift, init, scanEndpoints, sync } from 'stagecraft';
import { EXAMPLE, fixture, REPO } from '../helpers.ts';

const BIN = join(REPO, 'packages/cli/src/bin.ts');

describe('detect (FR-101)', () => {
  it('detects the reference app', () => {
    const d = detect(EXAMPLE);
    expect(d.framework).toMatchObject({ name: 'react', tier: 1 });
    expect(d.bundler).toBe('vite');
    expect(d.router).toBe('react-router-dom');
    expect(d.devPort).toBe(5174);
    expect(d.devCommand).toMatch(/run dev$/);
    expect(d.typescript).toBe(true);
    expect(d.flagVendor).toEqual([]);
  });

  it('detects the Vue and Nuxt reference apps', () => {
    const v = detect(join(REPO, 'examples/ref-vue-vite'));
    expect(v.framework).toMatchObject({ name: 'vue', tier: 1 });
    expect(v).toMatchObject({ bundler: 'vite', router: 'vue-router', devPort: 5175, typescript: true });
    expect(v.stateLibrary).toEqual(['pinia']);
    const n = detect(join(REPO, 'examples/ref-nuxt'));
    expect(n.framework).toMatchObject({ name: 'nuxt', tier: 1 });
    expect(n).toMatchObject({ bundler: 'vite', router: 'nuxt-pages', devPort: 3130 });
    expect(n.devCommand).toMatch(/run dev$/);
  });

  it('detects other stacks from package.json and files', () => {
    const fx = fixture('detect');
    writeFileSync(join(fx.root, 'package.json'), JSON.stringify({ scripts: { dev: 'nuxt dev --port 3001' }, dependencies: { nuxt: '^3.12.0', vue: '^3.4.0', pinia: '^2', '@growthbook/growthbook': '^1', '@apollo/client': '^3' }, devDependencies: { storybook: '^8.4.0', '@storybook/addon-mcp': '^0.1.0' } }));
    writeFileSync(join(fx.root, 'pnpm-lock.yaml'), '');
    writeFileSync(join(fx.root, '.nvmrc'), '20.11.0\n');
    writeFileSync(join(fx.root, 'openapi.yaml'), 'openapi: 3.0.0');
    const d = detect(fx.root);
    expect(d.framework).toMatchObject({ name: 'nuxt', tier: 1 });
    expect(d.packageManager).toBe('pnpm');
    expect(d.devCommand).toBe('pnpm dev');
    expect(d.devPort).toBe(3001);
    expect(d.node).toBe('20.11.0');
    expect(d.apiStyle).toEqual(expect.arrayContaining(['graphql', 'rest (openapi)']));
    expect(d.stateLibrary).toEqual(expect.arrayContaining(['pinia', '@apollo/client']));
    expect(d.flagVendor).toEqual(['growthbook']);
    expect(d.storybook).toEqual({ version: '8.4.0', mcpAddon: true });
  });
});

describe('init and agent files (FR-106, FR-303, FR-304)', () => {
  it('creates config, mocks, agent files, skills and MCP config; keeps user content', () => {
    const fx = fixture('init');
    const root = join(fx.root, 'fresh');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^6.0.0' } }));
    writeFileSync(join(root, 'AGENTS.md'), '# Team rules\n\nUse tabs.\n');
    init(root, () => {});
    for (const f of ['stagecraft.config.ts', 'stagecraft/mocks.ts', 'stagecraft/seed.ts', 'stagecraft/states.ts', 'stagecraft/agents.md', '.env.stagecraft', 'CLAUDE.md', '.cursor/rules/stagecraft.mdc', '.claude/skills/stagecraft-make-tape/SKILL.md', '.agents/skills/stagecraft-self-check/SKILL.md', '.cursor/skills/stagecraft-handoff/SKILL.md', '.mcp.json', '.cursor/mcp.json', '.codex/config.toml', 'stagecraft.detect.json']) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toMatch(/^# Team rules\n\nUse tabs\./);
    expect(agents).toContain('Stagecraft prototyping rules');
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');
    expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.stagecraft.args).toEqual(['--no', 'stagecraft', 'mcp']);
    expect(readFileSync(join(root, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.stagecraft]');
    const skill = readFileSync(join(root, '.claude/skills/stagecraft-make-tape/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: make-tape\ndescription: /);
    // Drift: edit the source → check fails → sync fixes it.
    expect(drift(root)).toEqual([]);
    writeFileSync(join(root, 'stagecraft/agents.md'), readFileSync(join(root, 'stagecraft/agents.md'), 'utf8') + '\n9. New rule.\n');
    expect(drift(root)).toEqual(expect.arrayContaining(['AGENTS.md', '.cursor/rules/stagecraft.mdc']));
    sync(root);
    expect(drift(root)).toEqual([]);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('9. New rule.');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toMatch(/^# Team rules/);
    // Re-running init keeps existing files.
    writeFileSync(join(root, 'stagecraft/mocks.ts'), '// mine\n');
    init(root, () => {});
    expect(readFileSync(join(root, 'stagecraft/mocks.ts'), 'utf8')).toBe('// mine\n');
  });

  it('agents check exits 1 on drift (CI)', () => {
    const fx = fixture('check');
    sync(fx.root);
    expect(spawnSync('node', [BIN, 'agents', 'check'], { cwd: fx.root }).status).toBe(0);
    writeFileSync(join(fx.root, 'CLAUDE.md'), 'hand edit');
    const r = spawnSync('node', [BIN, 'agents', 'check'], { cwd: fx.root, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('CLAUDE.md');
  });
});

describe('doctor (FR-108, FR-507)', () => {
  it('passes on the reference app', async () => {
    const r = await doctor(EXAMPLE);
    expect(r.errors).toEqual([]);
    expect(r.ok.join('\n')).toMatch(/Every endpoint string found in product code has a mock/);
  });

  it('passes on the Vue and Nuxt reference apps', async () => {
    for (const app of ['examples/ref-vue-vite', 'examples/ref-nuxt']) {
      const r = await doctor(join(REPO, app));
      expect(r.errors, app).toEqual([]);
      expect(r.warnings, app).toEqual([]);
    }
  });

  it('finds unmocked endpoints, mock leakage and stale scenarios', async () => {
    const fx = fixture('doctor');
    mkdirSync(join(fx.root, 'src'));
    writeFileSync(join(fx.root, 'src/inv.ts'), 'export const f = (id: string) => fetch(`/api/invoices/${id}`);\nfetch("/api/me");');
    writeFileSync(join(fx.root, 'src/leak.ts'), "import { seed } from '../stagecraft/seed';\nexport default seed;");
    writeFileSync(join(fx.root, 'stagecraft/scenarios/old.json'), JSON.stringify({ name: 'Old', states: { account: 'gone' } }));
    const r = await doctor(fx.root);
    expect(r.errors.join('\n')).toMatch(/imports mock code from stagecraft\/[\s\S]*src\/leak\.ts/);
    expect(r.warnings.join('\n')).toMatch(/\/api\/invoices\/:param/);
    expect(r.warnings.join('\n')).not.toMatch(/\/api\/me\b/);
    expect(r.warnings.join('\n')).toMatch(/Scenario "Old" is stale: unknown state account=gone/);
  });

  it('scans endpoint literals', () => {
    expect(scanEndpoints("fetch('/api/a?x=1'); fetch(`/api/b/${id}/c`); fetch('/other')", ['/api'])).toEqual(['/api/a', '/api/b/:param/c']);
  });
});

describe('CLI binary', () => {
  it('validates tapes with an exit code', () => {
    const ok = spawnSync('node', [BIN, 'tape', 'validate', join(EXAMPLE, 'stagecraft/tapes/vendor-payment-approval.json')], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    const fx = fixture('cli');
    const bad = join(fx.root, 'bad.json');
    writeFileSync(bad, JSON.stringify({ version: 1, id: 'b', title: 'b', events: [{ type: 'x' }] }));
    const r = spawnSync('node', [BIN, 'tape', 'validate', bad], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('$.events[0].type');
  });

  it('lists scenarios and prints help', () => {
    const out = execFileSync('node', [BIN, 'scenario', 'list'], { cwd: EXAMPLE, encoding: 'utf8' });
    expect(out).toContain('Bill pay company – frozen (extends Bill pay company)');
    expect(execFileSync('node', [BIN, 'help'], { encoding: 'utf8' })).toContain('stagecraft init');
  });
});

describe('init placeholders', () => {
  it('doctor warns while template placeholders remain', async () => {
    const fx = fixture('ph');
    const root = join(fx.root, 'fresh');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^19.0.0' } }));
    init(root, () => {});
    const r = await doctor(root);
    expect(r.warnings.join('\n')).toMatch(/Template placeholders are still in the config: persona "admin", persona "member", state account.active/);
  });
});
