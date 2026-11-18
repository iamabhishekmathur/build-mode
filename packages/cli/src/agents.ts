import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedRepo } from '@stagecraft/server';

export const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
export const SOURCE = 'stagecraft/agents.md';
const BEGIN = '<!-- stagecraft:begin (generated from stagecraft/agents.md by "stagecraft agents sync"; edit the source) -->';
const END = '<!-- stagecraft:end -->';
export const SKILL_DIRS = ['.claude/skills', '.agents/skills', '.cursor/skills'];

/** Put generated content between markers so user content in the same file is kept. */
function upsertBlock(existing: string | null, block: string): string {
  const wrapped = `${BEGIN}\n${block.trim()}\n${END}`;
  if (!existing) return wrapped + '\n';
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1) return existing.slice(0, start) + wrapped + existing.slice(end + END.length);
  return existing.trimEnd() + '\n\n' + wrapped + '\n';
}

const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);

/** Generated "Workspace repos" section for multi-repo products. */
export function workspaceSection(repos: ResolvedRepo[]): string {
  const others = repos.filter((r) => !r.host);
  if (!others.length) return '';
  const rule = (r: ResolvedRepo) =>
    r.role === 'library'
      ? `Edit the source here, never the copy in node_modules. It is linked into the apps for dev${r.package ? ` as \`${r.package}\`` : ''}. Export new components from the package entry.`
      : r.role === 'app'
        ? `Another frontend${r.mount ? ` served at \`${r.mount}\`` : r.port ? ` served on proxy port ${r.port}` : ''}. Same mock DB, personas and states as this app.`
        : r.role === 'api'
          ? `Read-only. Do not edit.${r.openapi ? ` \`${r.openapi}\` is the API contract: mocks must match it.` : ''}`
          : r.readOnly
            ? 'Read-only.'
            : '';
  const rows = others.map((r) => `| ${r.name} | \`${r.path}\` | ${r.role}${r.package ? ` (\`${r.package}\`)` : ''} | ${rule(r)} |`).join('\n');
  return `

## Workspace repos
This product spans several repos. Paths are relative to this repo. Stagecraft config, scenarios and tapes live here.

| Repo | Path | Role | Rules |
|---|---|---|---|
${rows}

- Before you change any repo, run \`npx stagecraft workspace branch <name>\` once, so every writable repo is on the same prototype branch.
- Put a change in the repo that owns it: shared components in the library repo, screens in the app repo. Do not copy library code into an app.
- \`npx stagecraft workspace status\` lists the repos you changed. A handoff is one PR per changed repo; link the PRs to each other.
`;
}

/** Merge our keys into .claude/settings.json without dropping the user's keys. */
function claudeSettings(root: string, repos: ResolvedRepo[]): string {
  let cur: any = {};
  try {
    cur = JSON.parse(read(join(root, '.claude/settings.json')) ?? '{}');
  } catch {
    cur = {};
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  const perms = cur.permissions ?? {};
  perms.allow = uniq([...(perms.allow ?? []), 'mcp__stagecraft', 'Bash(npx stagecraft:*)', 'Bash(npx tsc:*)']);
  const dirs = repos.filter((r) => !r.host).map((r) => r.path);
  if (dirs.length) perms.additionalDirectories = uniq([...(perms.additionalDirectories ?? []), ...dirs]);
  cur.permissions = perms;
  cur.enabledMcpjsonServers = uniq([...(cur.enabledMcpjsonServers ?? []), 'stagecraft']);
  return JSON.stringify(cur, null, 2) + '\n';
}

/** Desired content of every generated agent file (FR-303, FR-304). */
export function plan(root: string, repos: ResolvedRepo[] = []): Map<string, string> {
  const srcFile = join(root, SOURCE);
  const source = (read(srcFile) ?? readFileSync(join(TEMPLATES, 'agents.md'), 'utf8')).trimEnd() + workspaceSection(repos);
  const out = new Map<string, string>();
  out.set('.claude/settings.json', claudeSettings(root, repos));
  if (repos.some((r) => !r.host)) {
    // Cursor / VS Code multi-root workspace: open this file to see every repo.
    out.set('stagecraft.code-workspace', JSON.stringify({ folders: repos.map((r) => ({ name: r.host ? 'host' : r.name, path: r.path })) }, null, 2) + '\n');
  }
  // Codex and Cursor read AGENTS.md. Claude Code reads CLAUDE.md, which imports AGENTS.md.
  out.set('AGENTS.md', upsertBlock(read(join(root, 'AGENTS.md')), source));
  out.set('CLAUDE.md', upsertBlock(read(join(root, 'CLAUDE.md')), '@AGENTS.md'));
  out.set('.cursor/rules/stagecraft.mdc', `---\ndescription: Stagecraft prototyping rules (mock data, states, variants, self-check)\nalwaysApply: true\n---\n\n${source.trim()}\n`);
  const skillsRoot = join(root, 'stagecraft', 'skills');
  const skillSrc = existsSync(skillsRoot) ? skillsRoot : join(TEMPLATES, 'skills');
  for (const name of readdirSync(skillSrc)) {
    const body = read(join(skillSrc, name, 'SKILL.md'));
    if (!body) continue;
    for (const d of SKILL_DIRS) out.set(`${d}/stagecraft-${name}/SKILL.md`, body);
  }
  return out;
}

export function sync(root: string, repos: ResolvedRepo[] = []): string[] {
  if (!existsSync(join(root, SOURCE))) {
    mkdirSync(join(root, 'stagecraft'), { recursive: true });
    writeFileSync(join(root, SOURCE), readFileSync(join(TEMPLATES, 'agents.md'), 'utf8'));
  }
  if (!existsSync(join(root, 'stagecraft', 'skills'))) cpSync(join(TEMPLATES, 'skills'), join(root, 'stagecraft', 'skills'), { recursive: true });
  const written: string[] = [];
  for (const [rel, content] of plan(root, repos)) {
    const file = join(root, rel);
    if (read(file) === content) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    written.push(rel);
  }
  return written;
}

/** Files that differ from the source. CI fails when this is not empty. */
export function drift(root: string, repos: ResolvedRepo[] = []): string[] {
  return [...plan(root, repos)].filter(([rel, content]) => read(join(root, rel)) !== content).map(([rel]) => rel);
}

/** MCP config for each agent. */
export function writeMcpConfigs(root: string): string[] {
  const written: string[] = [];
  const server = { command: 'npx', args: ['stagecraft', 'mcp'] };
  for (const rel of ['.mcp.json', '.cursor/mcp.json']) {
    const file = join(root, rel);
    let cfg: any = {};
    try {
      cfg = JSON.parse(read(file) ?? '{}');
    } catch {
      cfg = {};
    }
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), stagecraft: server };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    written.push(rel);
  }
  const codex = join(root, '.codex/config.toml');
  const block = `[mcp_servers.stagecraft]\ncommand = "npx"\nargs = ["stagecraft", "mcp"]\n`;
  const cur = read(codex) ?? '';
  if (!cur.includes('[mcp_servers.stagecraft]')) {
    mkdirSync(dirname(codex), { recursive: true });
    writeFileSync(codex, (cur ? cur.trimEnd() + '\n\n' : '') + block);
    written.push('.codex/config.toml');
  }
  return written;
}
