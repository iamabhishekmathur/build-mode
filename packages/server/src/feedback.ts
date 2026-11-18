import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clone, type Json, type SessionState } from '@stagecraft/core';
import { UserError, type Engine } from './engine.ts';
import { settle } from './settle.ts';

/** Status flow (FR-905): open → sent (to agent) → agent_done → resolved | wont_fix. Only humans resolve. */
export type FeedbackStatus = 'open' | 'sent' | 'agent_done' | 'resolved' | 'wont_fix';
export type Actor = 'human' | 'agent';

export interface FeedbackAnchor {
  /** CSS selector (data-testid / id / tag path). */
  selector?: string;
  /** Visible text of the element, for re-anchoring after layout changes. */
  text?: string;
  /** Page-relative box (CSS px). For region comments this is the region. */
  box: { x: number; y: number; width: number; height: number };
  kind: 'element' | 'region';
}

export interface FeedbackSource {
  component?: string;
  file?: string;
  line?: number;
  framework?: string;
}

export interface FeedbackReply {
  at: string;
  actor: Actor;
  author: string;
  text: string;
  commit?: string;
  before?: string;
  after?: string;
}

/** One comment with everything an agent needs to act on it (FR-902). */
export interface Feedback {
  id: string;
  createdAt: string;
  author: string;
  text: string;
  status: FeedbackStatus;
  url: string;
  viewport: { width: number; height: number };
  anchor: FeedbackAnchor;
  source?: FeedbackSource;
  /** Persona, states, flags, variants and faults when the comment was made. */
  state: SessionState;
  scenario?: string;
  variant?: Record<string, string>;
  /** git HEAD of the host repo (the "version"). */
  version?: string;
  screenshot?: string;
  replies: FeedbackReply[];
}

const HUMAN_ONLY: FeedbackStatus[] = ['resolved', 'wont_fix', 'open'];

function gitHead(root: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Comments live in `.stagecraft-cache/feedback/` of the host repo (not committed).
 * Each comment keeps a copy of the mock DB, so before/after screenshots use the same data.
 */
export class FeedbackStore {
  private engine: Engine;
  private items: Feedback[] = [];
  private loadedFrom = '';
  /** Base URL of the proxy, for screenshots. Set by the server once it listens. */
  baseUrl = '';
  log: (m: string) => void;

  constructor(engine: Engine) {
    this.engine = engine;
    this.log = engine.log;
  }

  get dir() {
    return join(this.engine.root, '.stagecraft-cache', 'feedback');
  }

  private load() {
    if (this.loadedFrom === this.dir) return;
    this.loadedFrom = this.dir;
    const f = join(this.dir, 'feedback.json');
    this.items = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
  }

  private save() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'feedback.json'), JSON.stringify(this.items, null, 2));
  }

  list(filter: { status?: string; path?: string } = {}): Feedback[] {
    this.load();
    return this.items.filter((f) => (!filter.status || filter.status.split(',').includes(f.status)) && (!filter.path || new URL(f.url, 'http://x').pathname === filter.path));
  }

  get(id: string): Feedback {
    this.load();
    const f = this.items.find((x) => x.id === id);
    if (!f) throw new UserError(`No feedback "${id}"`, 404);
    return f;
  }

  async create(sessionId: string, input: { text: string; author?: string; url: string; viewport: { width: number; height: number }; anchor: FeedbackAnchor; source?: FeedbackSource }): Promise<Feedback> {
    this.load();
    if (!input.text?.trim()) throw new UserError('Comment text is required');
    if (!input.anchor?.box) throw new UserError('anchor.box is required');
    const s = this.engine.getSession(sessionId);
    const id = `c${(this.items.length + 1).toString().padStart(3, '0')}-${Date.now().toString(36).slice(-4)}`;
    const fb: Feedback = {
      id,
      createdAt: new Date().toISOString(),
      author: input.author?.trim() || 'Viewer',
      text: input.text.trim(),
      status: 'open',
      url: input.url,
      viewport: input.viewport,
      anchor: input.anchor,
      source: input.source,
      state: clone(s.state),
      scenario: s.state.scenario,
      variant: Object.keys(s.state.variants).length ? { ...s.state.variants } : undefined,
      version: gitHead(this.engine.root),
      replies: [],
    };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${id}.db.json`), JSON.stringify(s.dbRef.db));
    this.items.push(fb);
    this.save();
    // Screenshot in the background; the comment is usable at once.
    this.capture(fb, 'before')
      .then((file) => {
        fb.screenshot = file;
        this.save();
      })
      .catch((e) => this.log(`Feedback screenshot failed: ${(e as Error).message}`));
    return fb;
  }

  setStatus(id: string, status: FeedbackStatus, actor: Actor, author = actor === 'agent' ? 'Agent' : 'Viewer', note?: string): Feedback {
    const fb = this.get(id);
    if (!['open', 'sent', 'agent_done', 'resolved', 'wont_fix'].includes(status)) throw new UserError(`Unknown status "${status}"`);
    if (actor === 'agent' && HUMAN_ONLY.includes(status)) throw new UserError(`Only a person can set "${status}". Reply with feedback_reply instead.`, 403);
    fb.status = status;
    if (note) fb.replies.push({ at: new Date().toISOString(), actor, author, text: note });
    this.save();
    return fb;
  }

  /** Mark open comments as sent to the agent (FR-903). Returns the batch. */
  send(ids?: string[]): Feedback[] {
    const batch = this.list({ status: 'open' }).filter((f) => !ids || ids.includes(f.id));
    for (const f of batch) f.status = 'sent';
    this.save();
    return batch;
  }

  /** The agent's reply with before/after screenshots (FR-904). Never resolves. */
  async reply(id: string, input: { text: string; commit?: string }): Promise<Feedback> {
    const fb = this.get(id);
    if (!input.text?.trim()) throw new UserError('Reply text is required');
    const after = await this.capture(fb, `after-${fb.replies.length + 1}`).catch((e) => {
      this.log(`After screenshot failed: ${(e as Error).message}`);
      return undefined;
    });
    fb.replies.push({ at: new Date().toISOString(), actor: 'agent', author: 'Agent', text: input.text.trim(), commit: input.commit ?? gitHead(this.engine.root), before: fb.screenshot, after });
    fb.status = 'agent_done';
    this.save();
    return fb;
  }

  shotPath(id: string, name: string) {
    const f = join(this.dir, `${id}-${name.replace(/[^a-z0-9-]/gi, '')}.png`);
    if (!existsSync(f)) throw new UserError('No such screenshot', 404);
    return f;
  }

  /** Re-create the comment's conditions in a throwaway session and screenshot it with the target outlined. */
  async capture(fb: Feedback, name: string): Promise<string> {
    if (!this.baseUrl) throw new Error('proxy URL unknown');
    let chromium: any;
    try {
      const mod = 'playwright';
      ({ chromium } = await import(mod));
    } catch {
      throw new Error('Playwright not installed: no feedback screenshots');
    }
    const e = this.engine;
    const tmp = e.fork('main');
    tmp.state = clone(fb.state);
    const dbFile = join(this.dir, `${fb.id}.db.json`);
    if (existsSync(dbFile)) tmp.dbRef = { db: JSON.parse(readFileSync(dbFile, 'utf8')) as Json };
    const u = new URL(fb.url, this.baseUrl);
    u.searchParams.set('__sc_session', tmp.id);
    u.searchParams.set('sc_panel', '0');
    u.searchParams.delete('__sc');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: fb.viewport, reducedMotion: 'reduce' });
      await page.goto(u.href, { waitUntil: 'load' });
      await settle(page);
      await page.evaluate((a: FeedbackAnchor) => {
        let box = a.box;
        if (a.kind === 'element' && a.selector) {
          const el = document.querySelector(a.selector);
          if (el) {
            const r = el.getBoundingClientRect();
            box = { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
          }
        }
        window.scrollTo(0, Math.max(0, box.y - innerHeight / 3));
        const d = document.createElement('div');
        d.setAttribute('style', `position:absolute;left:${box.x - 4}px;top:${box.y - 4}px;width:${box.width + 8}px;height:${box.height + 8}px;border:3px solid #e5484d;border-radius:6px;box-shadow:0 0 0 9999px rgba(0,0,0,.08);pointer-events:none;z-index:2147483646`);
        document.body.appendChild(d);
      }, fb.anchor);
      await page.waitForTimeout(100);
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${fb.id}-${name}.png`);
      await page.screenshot({ path: file, animations: 'disabled' });
      return name;
    } finally {
      await browser.close();
      e.sessions.delete(tmp.id);
    }
  }
}
