import { join } from 'node:path';
import { cloneMissing, findConfig, linkLibraries, loadConfig, resolveWorkspace, switchBranch, unlinkLibraries, workspaceStatus, type ResolvedRepo } from '@stagecraft/server';

/** Host root and workspace repos from the nearest stagecraft.config.ts (host only if none). */
export async function loadRepos(cwd: string): Promise<{ root: string; repos: ResolvedRepo[] }> {
  const file = findConfig(cwd);
  if (!file) return { root: cwd, repos: [] };
  const { config, root } = await loadConfig(file);
  return { root, repos: resolveWorkspace(root, config) };
}

export async function workspaceCommand(cwd: string, sub: string | undefined, args: string[], log: (m: string) => void): Promise<number> {
  const file = findConfig(cwd);
  if (!file) throw new Error('No stagecraft.config.ts. Run "stagecraft init" in the host repo.');
  const { repos } = await loadRepos(cwd);
  switch (sub) {
    case 'status': {
      const st = workspaceStatus(repos);
      if (args.includes('--json')) {
        log(JSON.stringify(st, null, 2));
        return 0;
      }
      for (const r of st) {
        const state = !r.present ? 'MISSING' : !r.git ? 'not a git repo' : `${r.branch ?? '(no commits)'}${r.changedFiles.length ? `, ${r.changedFiles.length} changed` : ', clean'}`;
        log(`${r.name.padEnd(12)} ${r.role.padEnd(8)} ${r.path.padEnd(20)} ${state}${r.readOnly ? ' (read-only)' : ''}`);
        for (const l of r.links) log(`${''.padEnd(14)}${l.linked ? '✓' : '✗'} ${l.package} ${l.linked ? 'linked' : 'NOT linked (run "stagecraft workspace link")'}`);
      }
      const changed = st.filter((r) => r.changedFiles.length);
      if (changed.length) log(`\nHandoff: ${changed.length} PR${changed.length > 1 ? 's' : ''} (${changed.map((r) => r.name).join(', ')}).`);
      return st.some((r) => !r.present) ? 1 : 0;
    }
    case 'clone':
      cloneMissing(repos, log);
      return 0;
    case 'link':
      linkLibraries(repos, log);
      return 0;
    case 'unlink':
      unlinkLibraries(repos, log);
      return 0;
    case 'branch': {
      const name = args[0];
      if (!name) throw new Error('Usage: stagecraft workspace branch <name>');
      switchBranch(repos, name.startsWith('proto/') ? name : `proto/${name}`, log);
      return 0;
    }
  }
  log('Usage: stagecraft workspace status [--json] | clone | link | unlink | branch <name>');
  return 1;
}

export { join };
