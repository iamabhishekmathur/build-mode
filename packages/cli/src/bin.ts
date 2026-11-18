#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateTape } from '@stagecraft/core';
import { detect, Engine, findConfig } from '@stagecraft/server';
import { drift, sync } from './agents.ts';
import { doctor } from './doctor.ts';
import { dev } from './dev.ts';
import { init } from './init.ts';
import { loadRepos, workspaceCommand } from './workspace.ts';
import { checkCommand, describeCommand, matrixCommand } from './checks.ts';
import { shareCommand } from './share.ts';

const HELP = `stagecraft — prototype in the real product on mock data

Usage:
  stagecraft init                 Detect the stack and add config, mocks, agent instructions, skills and MCP config
  stagecraft detect               Write stagecraft.detect.json
  stagecraft dev [--port N] [--no-dev-server] [--no-link] [--host H]
                                  Start the dev server and the Stagecraft proxy
  stagecraft doctor               Check config, mocks, scenarios, tapes, mock leakage and agent files
  stagecraft agents sync          Regenerate AGENTS.md, CLAUDE.md, Cursor rules and skills from stagecraft/agents.md
  stagecraft agents check         Exit 1 if generated agent files drifted (for CI)
  stagecraft scenario list        List saved scenarios
  stagecraft tape validate <file> Validate a tape file
  stagecraft workspace status|clone|link|unlink|branch <name>
                                  Multi-repo products: repo status, clone missing repos, dev-link
                                  library packages, one prototype branch across repos
  stagecraft check fast|components|a11y|visual|handoff
                                  Checks on your own work (see --help of each); exit 1 on errors
  stagecraft matrix <route> [--viewports desktop,phone] [--cells cells.json]
                                  Grid of screenshots across states/personas/viewports
  stagecraft describe [--gate]    PR description: screens, states, scenarios, tapes, backend work, gate
  stagecraft share [path] [--expires 7d] [--password p] | share list | share revoke <id>
                                  Share link to a frozen copy of the current view (viewers: explore + comment)
  stagecraft mcp                  Run the MCP server on stdio (used by Claude Code, Codex, Cursor)
`;

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const args = [sub ?? '', ...rest];
  const cwd = process.cwd();
  const log = (m: string) => console.log(m);
  switch (cmd) {
    case 'init':
      init(cwd, log);
      return 0;
    case 'detect': {
      const d = detect(cwd);
      writeFileSync(join(cwd, 'stagecraft.detect.json'), JSON.stringify(d, null, 2) + '\n');
      console.log(JSON.stringify(d, null, 2));
      return 0;
    }
    case 'dev': {
      const port = flag(args, '--port');
      await dev(cwd, { port: port ? Number(port) : undefined, noDevServer: args.includes('--no-dev-server'), noLink: args.includes('--no-link'), host: flag(args, '--host') });
      return null;
    }
    case 'doctor': {
      const r = await doctor(cwd);
      for (const m of r.ok) console.log(`✓ ${m}`);
      for (const m of r.warnings) console.log(`! ${m}`);
      for (const m of r.errors) console.log(`✗ ${m}`);
      return r.errors.length ? 1 : 0;
    }
    case 'workspace':
      return workspaceCommand(cwd, sub, rest, log);
    case 'check':
      return checkCommand(cwd, sub, rest, log);
    case 'matrix':
      return matrixCommand(cwd, sub, rest, log);
    case 'describe':
      return describeCommand(cwd, args, log);
    case 'share':
      return shareCommand(cwd, sub, rest, log);
    case 'agents': {
      const { root, repos } = await loadRepos(cwd);
      if (sub === 'sync') {
        const w = sync(root, repos);
        console.log(w.length ? w.map((f) => `wrote ${f}`).join('\n') : 'Agent files are up to date.');
        return 0;
      }
      if (sub === 'check') {
        const d = drift(root, repos);
        if (d.length) {
          console.log(`Out of sync: ${d.join(', ')}\nRun "npx --no stagecraft agents sync".`);
          return 1;
        }
        console.log('Agent files are in sync.');
        return 0;
      }
      break;
    }
    case 'scenario': {
      const file = findConfig(cwd);
      if (!file) throw new Error('No stagecraft.config.ts');
      const e = await new Engine(file, { log: () => {} }).init();
      for (const s of e.listScenarios()) console.log(`${s.name}${s.extends ? ` (extends ${s.extends})` : ''}${s.description ? ` — ${s.description}` : ''}`);
      return 0;
    }
    case 'tape': {
      if (sub !== 'validate' || !rest[0]) break;
      const issues = validateTape(JSON.parse(readFileSync(rest[0], 'utf8')));
      if (!issues.length) {
        console.log('Tape is valid.');
        return 0;
      }
      for (const i of issues) console.log(`${i.path}: ${i.message}`);
      return 1;
    }
    case 'mcp':
      await import('@stagecraft/mcp/bin');
      return null;
  }
  console.log(HELP);
  return cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0;
}

main().then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (err) => {
    console.error(`stagecraft: ${(err as Error).message}`);
    process.exit(1);
  },
);
