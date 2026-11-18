import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { checkComponents } from '@stagecraft/checks';
import { findConfig, loadConfig } from '@stagecraft/server';

/**
 * Claude Code hooks (FR-306). Claude Code sends the tool call as JSON on stdin.
 * Exit code 2 sends stderr back to the agent in the same turn.
 *   post-edit: design-system check on the edited file.
 *   pre-bash: block commits with secrets / production env files, and plain `npx stagecraft`.
 */
async function stdinJson(): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Stripe live key', /\b(?:sk|rk)_live_[0-9a-zA-Z]{16,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Anthropic/OpenAI key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{30,}\b/],
  ['connection string with password', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:[^@\s]+@/],
];

export async function hookCommand(cwd: string, kind: string | undefined, log: (m: string) => void): Promise<number> {
  const input = await stdinJson();
  const file = findConfig(cwd);
  const root = file ? (await loadConfig(file)).root : cwd;
  const fail = (msg: string) => {
    process.stderr.write(msg + '\n');
    return 2;
  };

  if (kind === 'post-edit') {
    const p: string | undefined = input.tool_input?.file_path ?? input.tool_input?.path;
    if (!p || !/\.(m?[jt]sx?|vue|svelte|css|scss)$/.test(p)) return 0;
    const rel = relative(root, p);
    if (rel.startsWith('..') || rel.startsWith('stagecraft/') || rel.includes('node_modules')) return 0;
    const r = checkComponents(root, { files: [rel] });
    const errors = r.findings.filter((f) => f.severity === 'error');
    if (!errors.length) return 0;
    return fail(
      `Stagecraft design-system check on ${rel}:\n` +
        errors.map((f) => `- line ${f.line}: ${f.message}`).join('\n') +
        `\nFix these, or explain an exception with a "stagecraft-allow: <reason>" comment on that line.`,
    );
  }

  if (kind === 'pre-bash') {
    const cmd: string = input.tool_input?.command ?? '';
    if (/\bnpx\s+(?!--no\b)(?:-[\w-]+\s+)*stagecraft\b/.test(cmd)) {
      return fail('Use "npx --no stagecraft …". The npm name "stagecraft" belongs to an unrelated package; without --no, npx may download and run it.');
    }
    if (/\bgit\b[^;&|]*\bcommit\b/.test(cmd)) {
      const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
      const envFiles = staged.filter((f) => /(^|\/)\.env(\.(production|prod|live))?$/.test(f) || /\.env\.(production|prod|live)\./.test(f));
      if (envFiles.length) return fail(`Blocked: the commit includes environment files that may hold real secrets: ${envFiles.join(', ')}. Unstage them.`);
      const diff = spawnSync('git', ['diff', '--cached', '-U0'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
      const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
      for (const [name, re] of SECRET_PATTERNS) {
        const hit = added.find((l) => re.test(l));
        if (hit) return fail(`Blocked: the commit adds what looks like a ${name}. Remove it; prototypes use fake values only (.env.stagecraft).`);
      }
    }
    return 0;
  }

  log('Usage: stagecraft hook post-edit | pre-bash   (reads a Claude Code hook event on stdin)');
  return 1;
}
