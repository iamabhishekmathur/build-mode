import { readFileSync } from 'node:fs';
import { branchFrom, commentPreview, createClient, DEFAULT_GATE, listBranchSources, openPr, openWorkspacePrs, prStatus, readyForEngineering, type GithubContext } from '@stagecraft/github';

export const GITHUB_HELP = `  stagecraft pr open [--title T] [--body-file F] [--slug S] [--message M] [--base B] [--workspace]
                                  Commit (you as author, the agent as co-author), push the prototype
                                  branch and create or update its draft PR (label stagecraft-prototype).
                                  --workspace: one PR per changed repo, libraries first, cross-linked
  stagecraft pr status [--json]   The PR of the current branch, its preview comment and check
  stagecraft pr comment [--body-file F] [--preview-url U] [--screenshot URL|file]
                                  Post or update the preview comment and the "Stagecraft" check
  stagecraft pr ready [--gate "<cmd>"] [--override "<reason>"] [--reviewer login]
                                  Ready for engineering if the handoff gate passes, or with a recorded override
  stagecraft branch-from list | <branch> [--slug S]
                                  Branches to start from, or start proto/<user>/<slug> from one
                                  (GitHub: GITHUB_TOKEN or GH_TOKEN; Stagecraft never merges)
`;

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function all(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === name && args[i + 1]) out.push(...args[i + 1]!.split(',').filter(Boolean));
  });
  return out;
}

const readBody = (args: string[]) => {
  const f = opt(args, '--body-file');
  return f === undefined ? undefined : readFileSync(f, 'utf8');
};

export async function githubCommand(cwd: string, cmd: string, sub: string | undefined, args: string[], log: (m: string) => void): Promise<number> {
  const json = args.includes('--json');
  const ctx: GithubContext = {
    client: createClient(),
    log: json ? undefined : log,
    user: opt(args, '--user'),
    coAuthor: opt(args, '--co-author') ?? process.env.STAGECRAFT_CO_AUTHOR,
  };
  const out = (v: unknown) => json && log(JSON.stringify(v, null, 2));

  if (cmd === 'branch-from') {
    if (!sub) {
      log('Usage: stagecraft branch-from list | <branch> [--slug S]');
      return 1;
    }
    if (sub === 'list') {
      const l = await listBranchSources(ctx, cwd);
      if (json) return out(l), 0;
      log('Prototypes:');
      for (const p of l.prototypes) log(`  ${p.name}${p.pr ? `  #${p.pr.number}${p.pr.draft ? ' (draft)' : ''} ${p.pr.url}` : '  (no open PR)'}`);
      if (!l.prototypes.length) log('  (none)');
      log('Branches:');
      for (const b of l.branches) log(`  ${b.name}${b.protected ? '  (protected)' : ''}`);
      return 0;
    }
    const r = await branchFrom(ctx, cwd, sub, { slug: opt(args, '--slug') });
    out(r);
    return 0;
  }

  switch (sub) {
    case 'open': {
      const o = { title: opt(args, '--title'), body: readBody(args), slug: opt(args, '--slug'), message: opt(args, '--message') };
      if (args.includes('--workspace')) {
        const r = await openWorkspacePrs(ctx, cwd, o);
        if (json) return out(r), 0;
        log(`\n${r.branch}: ${r.prs.length} PR${r.prs.length > 1 ? 's' : ''} (merge in this order)`);
        r.prs.forEach((p, i) => log(`  ${i + 1}. ${p.name} (${p.role}) ${p.url}`));
        return 0;
      }
      const r = await openPr(ctx, cwd, { ...o, base: opt(args, '--base') });
      out({ repo: r.repo, branch: r.branch, base: r.base, number: r.pr.number, url: r.pr.html_url, draft: r.pr.draft, created: r.created, committed: r.committed });
      return 0;
    }
    case 'status': {
      const s = await prStatus(ctx, cwd);
      if (json) return out(s), 0;
      if (!s.pr) {
        log(`${s.repo.owner}/${s.repo.repo} ${s.branch}: no open PR. Run "npx --no stagecraft pr open".`);
        return 1;
      }
      log(`${s.repo.owner}/${s.repo.repo}#${s.pr.number} ${s.pr.draft ? 'draft' : 'ready for review'}: ${s.pr.title}`);
      log(`  ${s.pr.html_url}`);
      log(`  ${s.branch} → ${s.pr.base.ref}${s.localAhead ? ' (local commits not pushed)' : ''}${s.dirty ? ' (uncommitted changes)' : ''}`);
      log(`  labels: ${s.pr.labels.map((l) => l.name).join(', ') || '(none)'}`);
      log(`  preview comment: ${s.previewComment?.html_url ?? '(none; run "pr comment")'}`);
      log(`  check: ${s.check ? `${s.check.name} ${s.check.conclusion ?? s.check.status}` : '(none)'}`);
      return 0;
    }
    case 'comment': {
      const conclusion = opt(args, '--conclusion') as 'success' | 'neutral' | 'failure' | undefined;
      const r = await commentPreview(ctx, cwd, { body: readBody(args), previewUrl: opt(args, '--preview-url'), screenshot: opt(args, '--screenshot'), conclusion });
      out({ number: r.pr.number, comment: r.comment.html_url, created: r.created, check: r.check?.conclusion ?? null, warning: r.checkWarning });
      return 0;
    }
    case 'ready': {
      const gate = opt(args, '--gate') ?? DEFAULT_GATE;
      const r = await readyForEngineering(ctx, cwd, { gate, override: opt(args, '--override'), reviewers: all(args, '--reviewer') });
      if (json) out(r);
      if (r.status === 'already-ready') log(`#${r.pr.number} is already ready for review.`);
      if (r.status === 'refused') {
        log(`Not ready for engineering: the handoff gate failed (\`${r.gate!.command}\`, exit ${r.gate!.code}).`);
        if (r.gate!.output) log(r.gate!.output.split('\n').map((l) => `  ${l}`).join('\n'));
        log(`\nFix these, or mark it ready anyway with a reason the engineer will see in the PR:\n  npx --no stagecraft pr ready --override "<reason>"`);
        return 1;
      }
      return 0;
    }
  }
  log(`Usage:\n${GITHUB_HELP}`);
  return 1;
}
