import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clone, type Json, type SessionState } from '@stagecraft/core';
import { UserError, type Engine, type Session } from './engine.ts';

/** A share link: a frozen copy of one view (state + mock DB) that viewers open in their own fork. */
export interface Share {
  id: string;
  token: string;
  label?: string;
  path: string;
  createdAt: string;
  expiresAt?: string;
  password?: { salt: string; hash: string };
  revoked?: boolean;
  state: SessionState;
}

const DUR = /^(\d+)\s*(m|h|d)$/;
export function parseExpiry(v: string | number | undefined): number | undefined {
  if (v === undefined || v === '' || v === 'never') return undefined;
  if (typeof v === 'number') return v * 1000;
  const m = DUR.exec(v.trim());
  if (!m) throw new UserError(`Expiry must look like 30m, 12h or 7d (got "${v}")`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

function hash(password: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

export class ShareStore {
  private engine: Engine;
  private items: Share[] | null = null;
  constructor(engine: Engine) {
    this.engine = engine;
  }
  private get dir() {
    return join(this.engine.root, '.stagecraft-cache', 'shares');
  }
  private load(): Share[] {
    if (!this.items) {
      const f = join(this.dir, 'shares.json');
      this.items = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
    }
    return this.items!;
  }
  private save() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'shares.json'), JSON.stringify(this.items, null, 2));
  }
  policyAllows() {
    return this.engine.config.sharing?.publicLinks !== false;
  }

  create(from: Session, input: { path?: string; expires?: string | number; password?: string; label?: string }): Share {
    if (!this.policyAllows()) throw new UserError('Share links are turned off for this workspace (sharing.publicLinks: false).', 403);
    if (from.viewer) throw new UserError('Viewers cannot create share links.', 403);
    const ms = parseExpiry(input.expires ?? this.engine.config.sharing?.defaultExpiry ?? '7d');
    const share: Share = {
      id: `s${Date.now().toString(36)}${randomBytes(2).toString('hex')}`,
      token: randomBytes(24).toString('base64url'),
      label: input.label,
      path: input.path && input.path.startsWith('/') ? input.path : '/',
      createdAt: new Date().toISOString(),
      expiresAt: ms ? new Date(Date.now() + ms).toISOString() : undefined,
      password: input.password ? hash(input.password) : undefined,
      state: clone(from.state),
    };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${share.id}.db.json`), JSON.stringify(from.dbRef.db));
    this.load().push(share);
    this.save();
    return share;
  }

  list() {
    return this.load().map(({ password, ...s }) => ({ ...s, hasPassword: !!password, active: this.problem(s as Share) === null }));
  }

  revoke(id: string) {
    const s = this.load().find((x) => x.id === id);
    if (!s) throw new UserError(`No share "${id}"`, 404);
    s.revoked = true;
    this.save();
    return s;
  }

  byToken(token: string): Share | undefined {
    return this.load().find((s) => s.token === token);
  }

  /** Why a share cannot be used now, or null. Checked on every request, so revoking or the policy acts at once. */
  problem(s: Share | undefined): string | null {
    if (!s) return 'This link does not exist.';
    if (!this.policyAllows()) return 'Share links are turned off for this workspace.';
    if (s.revoked) return 'This link was revoked.';
    if (s.expiresAt && Date.parse(s.expiresAt) < Date.now()) return 'This link has expired.';
    return null;
  }

  checkPassword(s: Share, password: string | undefined): boolean {
    if (!s.password) return true;
    if (!password) return false;
    const h = Buffer.from(hash(password, s.password.salt).hash, 'hex');
    return timingSafeEqual(h, Buffer.from(s.password.hash, 'hex'));
  }

  /** A new viewer session: its own copy of the shared state and DB (fork-on-open, FR-504). */
  open(s: Share): Session {
    // Random id: a viewer session id works like a bearer secret for remote viewers.
    const v = this.engine.getSession(`v${randomBytes(12).toString('base64url')}`);
    v.state = clone(s.state);
    const f = join(this.dir, `${s.id}.db.json`);
    if (existsSync(f)) v.dbRef = { db: JSON.parse(readFileSync(f, 'utf8')) as Json };
    v.viewer = { shareId: s.id };
    return v;
  }

  viewerProblem(session: Session): string | null {
    if (!session.viewer) return null;
    return this.problem(this.load().find((x) => x.id === session.viewer!.shareId));
  }
}
