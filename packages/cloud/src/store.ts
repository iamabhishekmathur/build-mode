import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { open, seal } from './crypto.ts';

export interface Policy {
  /** Strict mode off = cloud allowed (FR-205). */
  cloud: boolean;
  /** Extra egress hosts for this tenant (exact or ".suffix"). */
  egressAllow: string[];
  /** Sandbox-minutes per calendar month; 0 = no cap (FR-1505). */
  monthlyMinutesCap: number;
  idleTimeoutSec: number;
  maxSessionSec: number;
  memoryMb: number;
  cpuPercent: number;
  pids: number;
}

export const DEFAULT_POLICY: Policy = { cloud: true, egressAllow: [], monthlyMinutesCap: 0, idleTimeoutSec: 30 * 60, maxSessionSec: 8 * 3600, memoryMb: 2048, cpuPercent: 200, pids: 512 };

export interface Tenant {
  id: string;
  name: string;
  /** Data key for this tenant's secrets, sealed with the master key. */
  sealedDek: string;
  tokens: { id: string; salt: string; hash: string; label: string; createdAt: string }[];
  secrets: Record<string, string>;
  policy: Policy;
}

export interface Workspace {
  id: string;
  tenant: string;
  repoUrl: string;
  ref: string;
  commit?: string;
  lockHash?: string;
  snapshot?: string;
  status: 'building' | 'ready' | 'failed';
  error?: string;
  buildMs?: number;
  createdAt: string;
}

export interface SessionRec {
  id: string;
  tenant: string;
  workspace: string;
  branch: string;
  status: 'starting' | 'running' | 'sleeping' | 'stopped' | 'failed';
  sandbox?: string;
  ip?: string;
  startedAt?: string;
  lastActiveAt?: string;
  error?: string;
  startMs?: number;
  dir: string;
}

export interface UsageEvent {
  tenant: string;
  session: string;
  start: number;
  end?: number;
}

export interface AuditEvent {
  at: string;
  actor: string;
  action: string;
  target: string;
  detail?: unknown;
}

interface Db {
  tenants: Record<string, Tenant>;
  workspaces: Record<string, Workspace>;
  sessions: Record<string, SessionRec>;
  usage: UsageEvent[];
  audit: AuditEvent[];
}

/**
 * Small JSON store with atomic writes. Secrets: per-tenant data key (DEK) sealed by the
 * master key (KEK); values sealed by the DEK. Plain values exist only in memory, in the
 * agent process env.
 */
export class Store {
  private db: Db;
  private file: string;
  private kek: Buffer;
  dir: string;

  constructor(dir: string, masterKey: string) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
    const k = Buffer.from(masterKey, 'base64');
    if (k.length !== 32) throw new Error('STAGECRAFT_MASTER_KEY must be 32 bytes, base64');
    this.kek = k;
    mkdirSync(dir, { recursive: true });
    this.db = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { tenants: {}, workspaces: {}, sessions: {}, usage: [], audit: [] };
  }

  save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.db, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get tenants() {
    return this.db.tenants;
  }
  get workspaces() {
    return this.db.workspaces;
  }
  get sessions() {
    return this.db.sessions;
  }
  get usage() {
    return this.db.usage;
  }

  audit(actor: string, action: string, target: string, detail?: unknown) {
    this.db.audit.push({ at: new Date().toISOString(), actor, action, target, detail });
    this.save();
  }
  auditLog(tenant?: string) {
    return this.db.audit.filter((a) => !tenant || a.actor.startsWith(`${tenant}:`) || a.target.startsWith(tenant));
  }

  newTenant(id: string, name: string): Tenant {
    const t: Tenant = { id, name, sealedDek: seal(this.kek, randomBytes(32)), tokens: [], secrets: {}, policy: { ...DEFAULT_POLICY } };
    this.db.tenants[id] = t;
    this.save();
    return t;
  }

  private dek(t: Tenant) {
    return open(this.kek, t.sealedDek);
  }

  setSecret(t: Tenant, name: string, value: string) {
    t.secrets[name] = seal(this.dek(t), value);
    this.save();
  }

  getSecret(t: Tenant, name: string): string | undefined {
    const s = t.secrets[name];
    return s ? open(this.dek(t), s).toString('utf8') : undefined;
  }
}
