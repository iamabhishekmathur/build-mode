/**
 * Sections of a PR body that Stagecraft owns, fenced by hidden markers so they can be rewritten
 * on every run without touching what the user or agent wrote around them.
 */
export type SectionKey = 'related' | 'override';

const start = (k: SectionKey) => `<!-- stagecraft:${k}:start -->`;
const end = (k: SectionKey) => `<!-- stagecraft:${k}:end -->`;
const ORDER: SectionKey[] = ['related', 'override'];

function sectionRe(k: SectionKey) {
  return new RegExp(`\\n*${start(k)}\\n?([\\s\\S]*?)\\n?${end(k)}\\n*`);
}

export function getSection(body: string, k: SectionKey): string | null {
  return sectionRe(k).exec(body)?.[1] ?? null;
}

/** Replace (or add, or with null remove) a managed section. */
export function setSection(body: string, k: SectionKey, content: string | null): string {
  const re = sectionRe(k);
  const block = content === null ? '\n\n' : `\n\n${start(k)}\n${content.trim()}\n${end(k)}\n\n`;
  // The regex eats the newlines around the old section, so the block brings its own blank lines.
  const out = re.test(body) ? body.replace(re, block) : content === null ? body : `${body.trimEnd()}${block}`;
  return out.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** The user-written part of a body (managed sections removed). */
export function userPart(body: string): string {
  let b = body;
  for (const k of ORDER) b = setSection(b, k, null);
  return b.trim();
}

/** New user text, keeping the managed sections of the old body. */
export function replaceUserPart(oldBody: string, newUser: string): string {
  let b = newUser.trim();
  for (const k of ORDER) {
    const s = getSection(oldBody, k);
    if (s !== null) b = setSection(b, k, s);
  }
  return b;
}

export function defaultBody(opts: { branch: string; base: string }): string {
  return [
    'Prototype made with Stagecraft. It runs the real frontend on mock data.',
    '',
    `Branch \`${opts.branch}\` → \`${opts.base}\`. This is a draft until the handoff gate passes (\`npx --no stagecraft pr ready\`).`,
    '',
    'Stagecraft never merges. An engineer reviews and merges under the repo\'s branch protection.',
  ].join('\n');
}
