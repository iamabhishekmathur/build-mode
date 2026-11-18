import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Desired content of every generated agent file (FR-303, FR-304). */
export function plan(root: string): Map<string, string> {
  const srcFile = join(root, SOURCE);
  const source = read(srcFile) ?? readFileSync(join(TEMPLATES, 'agents.md'), 'utf8');
  const out = new Map<string, string>();
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

export function sync(root: string): string[] {
  if (!existsSync(join(root, SOURCE))) {
    mkdirSync(join(root, 'stagecraft'), { recursive: true });
    writeFileSync(join(root, SOURCE), readFileSync(join(TEMPLATES, 'agents.md'), 'utf8'));
  }
  if (!existsSync(join(root, 'stagecraft', 'skills'))) cpSync(join(TEMPLATES, 'skills'), join(root, 'stagecraft', 'skills'), { recursive: true });
  const written: string[] = [];
  for (const [rel, content] of plan(root)) {
    const file = join(root, rel);
    if (read(file) === content) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    written.push(rel);
  }
  return written;
}

/** Files that differ from the source. CI fails when this is not empty. */
export function drift(root: string): string[] {
  return [...plan(root)].filter(([rel, content]) => read(join(root, rel)) !== content).map(([rel]) => rel);
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
