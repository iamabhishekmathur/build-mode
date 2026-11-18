import {
  applyPatch,
  clone,
  formatPosition,
  matches,
  pathTo,
  parsePosition,
  segmentEvents,
  type Json,
  type Position,
  type Tape,
  type TapeEvent,
} from '@stagecraft/core';

/** Event sent to the product's chat UI over SSE or WebSocket. */
export interface WireEvent {
  type: string;
  replay?: boolean;
  [k: string]: unknown;
}

export interface TapeClient {
  send(evt: WireEvent): void;
  close(): void;
}

export interface PlayerHost {
  getDb(): Json;
  setDb(db: Json): void;
  dbChanged(): void;
  onDbChange(fn: () => void): () => void;
  status(s: TapeStatus): void;
}

export interface TapeStatus {
  id: string;
  title: string;
  at: string;
  segment: string;
  index: number;
  total: number;
  playing: boolean;
  waiting: null | 'branch' | 'retry';
  done: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plays one tape for one session. The UI is a pure function of the wire history, so deep links equal playback. */
export class TapePlayer {
  readonly tape: Tape;
  private host: PlayerHost;
  private base: Json;
  private pos: Position = { segment: 'main', index: 0 };
  private history: WireEvent[] = [];
  private clients = new Set<TapeClient>();
  private playing = false;
  private running = false;
  private waiting: TapeStatus['waiting'] = null;
  private done = false;
  private disposed = false;
  private stopBranchWatch: (() => void) | null = null;
  private generation = 0;
  private msgCounter = 0;
  /** Scale for delays (tests use < 1). */
  speed = 1;

  constructor(tape: Tape, host: PlayerHost) {
    this.tape = tape;
    this.host = host;
    this.base = clone(host.getDb());
  }

  /** Jump to a position: reset DB to the tape base, then apply every state change on the path. */
  seek(at: string | undefined, autoplay: boolean) {
    this.generation++;
    this.stopBranchWatch?.();
    this.stopBranchWatch = null;
    this.waiting = null;
    this.done = false;
    this.msgCounter = 0;
    const pos = parsePosition(at);
    const { events, choices } = pathTo(this.tape, pos);
    const db = clone(this.base);
    this.history = [];
    let choiceIdx = 0;
    for (const ev of events) {
      if (ev.type === 'state_change') applyPatch(db, ev.patch);
      if (ev.type === 'branch') {
        // The viewer's action on the way here: make its condition true in the DB.
        const c = choices[choiceIdx++];
        if (c && c.when.equals !== undefined) applyPatch(db, { [c.when.path]: c.when.equals });
        continue;
      }
      this.history.push(...this.instant(ev));
    }
    this.host.setDb(db);
    this.host.dbChanged();
    this.pos = pos;
    // At a branch the tape waits for the viewer, paused or not: their click in the real UI continues it.
    this.playing = autoplay || this.current()?.type === 'branch';
    for (const c of this.clients) this.replayTo(c);
    this.report();
    if (this.playing) void this.run();
  }

  attach(client: TapeClient) {
    this.clients.add(client);
    this.replayTo(client);
    if (this.waiting === 'retry') {
      // A reconnect after a timeout is the product's retry. Continue the tape.
      this.waiting = null;
      this.playing = true;
      this.report();
    }
    if (this.playing) void this.run();
  }

  detach(client: TapeClient) {
    this.clients.delete(client);
  }

  play() {
    if (this.done) return;
    this.playing = true;
    if (this.waiting === 'retry' && this.clients.size) this.waiting = null;
    this.report();
    void this.run();
  }

  pause() {
    this.playing = false;
    this.report();
  }

  /** Run exactly one event with no waiting. */
  async stepOnce() {
    if (this.running || this.done || this.waiting) return;
    this.playing = false;
    const ev = this.current();
    if (!ev) return this.finish();
    await this.exec(ev, true, this.generation);
    this.report();
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.stopBranchWatch?.();
    for (const c of this.clients) c.close();
    this.clients.clear();
  }

  status(): TapeStatus {
    return {
      id: this.tape.id,
      title: this.tape.title,
      at: formatPosition(this.pos),
      segment: this.pos.segment,
      index: this.pos.index,
      total: segmentEvents(this.tape, this.pos.segment).length,
      playing: this.playing,
      waiting: this.waiting,
      done: this.done,
    };
  }

  private report() {
    if (!this.disposed) this.host.status(this.status());
  }

  private replayTo(c: TapeClient) {
    c.send({ type: 'hello', tape: { id: this.tape.id, title: this.tape.title }, at: formatPosition(this.pos) });
    for (const e of this.history) c.send({ ...e, replay: true });
  }

  private current(): TapeEvent | undefined {
    return segmentEvents(this.tape, this.pos.segment)[this.pos.index];
  }

  private broadcast(e: WireEvent, record = true) {
    if (record) this.history.push(e);
    for (const c of this.clients) c.send(e);
  }

  private finish() {
    if (!this.done) {
      this.done = true;
      this.playing = false;
      this.broadcast({ type: 'done' });
      this.report();
    }
  }

  private async run() {
    if (this.running) return;
    // Wait for the chat UI to connect, so nobody misses the live stream. Branch waits need no client.
    if (!this.clients.size && this.current()?.type !== 'branch') return;
    this.running = true;
    const gen = this.generation;
    try {
      while (this.playing && !this.waiting && gen === this.generation && !this.disposed) {
        const ev = this.current();
        if (!ev) {
          this.finish();
          break;
        }
        await this.exec(ev, false, gen);
        if (gen !== this.generation) break;
        this.report();
      }
    } finally {
      this.running = false;
    }
  }

  private advance() {
    this.pos = { ...this.pos, index: this.pos.index + 1 };
  }

  /** Wire form of an event when replayed with no timing. */
  private instant(ev: TapeEvent): WireEvent[] {
    switch (ev.type) {
      case 'agent_message': {
        const id = ev.id ?? `m${++this.msgCounter}`;
        const text = ev.cutAt !== undefined ? ev.text.slice(0, ev.cutAt) : ev.text;
        return [
          { type: 'message_start', id, role: 'assistant' },
          { type: 'token', id, text },
          { type: 'message_end', id, partial: ev.cutAt !== undefined },
        ];
      }
      case 'delay':
      case 'branch':
        return [];
      case 'state_change':
        return [{ type: 'state_change' }];
      case 'timeout':
        return [{ type: 'timeout', afterMs: ev.afterMs }];
      default: {
        const { label: _l, ...rest } = ev as TapeEvent & { label?: string };
        return [rest as WireEvent];
      }
    }
  }

  private async exec(ev: TapeEvent, instant: boolean, gen: number) {
    const live = (ms: number) => (instant ? Promise.resolve() : sleep(ms * this.speed));
    switch (ev.type) {
      case 'agent_message': {
        if (instant) {
          for (const w of this.instant(ev)) this.broadcast(w);
          break;
        }
        const id = ev.id ?? `m${++this.msgCounter}`;
        const text = ev.cutAt !== undefined ? ev.text.slice(0, ev.cutAt) : ev.text;
        const size = ev.chunkSize ?? 4;
        // Live clients get chunks; history keeps the collapsed form so replays are identical.
        this.broadcast({ type: 'message_start', id, role: 'assistant' });
        for (let i = 0; i < text.length; i += size) {
          if (gen !== this.generation) return;
          this.broadcast({ type: 'token', id, text: text.slice(i, i + size) }, false);
          await live(ev.tokenDelayMs ?? 30);
        }
        this.history.push({ type: 'token', id, text });
        this.broadcast({ type: 'message_end', id, partial: ev.cutAt !== undefined });
        break;
      }
      case 'delay':
        await live(ev.ms);
        break;
      case 'state_change': {
        const db = this.host.getDb();
        applyPatch(db, ev.patch);
        this.host.setDb(db);
        this.host.dbChanged();
        this.broadcast({ type: 'state_change' });
        break;
      }
      case 'timeout': {
        await live(ev.afterMs);
        if (gen !== this.generation) return;
        this.broadcast({ type: 'timeout', afterMs: ev.afterMs });
        this.advance();
        this.waiting = 'retry';
        this.playing = false;
        for (const c of this.clients) c.close();
        this.clients.clear();
        return;
      }
      case 'branch': {
        await this.waitBranch(ev, instant, gen);
        return;
      }
      default:
        for (const w of this.instant(ev)) this.broadcast(w);
    }
    if (gen === this.generation) this.advance();
  }

  private waitBranch(ev: Extract<TapeEvent, { type: 'branch' }>, instant: boolean, gen: number): Promise<void> {
    const pick = () => ev.cases.find((c) => matches(this.host.getDb(), c.when))?.goto;
    const take = (seg: string) => {
      this.waiting = null;
      this.pos = { segment: seg, index: 0 };
    };
    const now = pick();
    if (now) {
      take(now);
      return Promise.resolve();
    }
    if (instant && ev.default) {
      take(ev.default);
      return Promise.resolve();
    }
    this.waiting = 'branch';
    this.report();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = this.host.onDbChange(() => {
        const seg = pick();
        if (seg) finish(seg);
      });
      const finish = (seg: string | null) => {
        stop();
        if (timer) clearTimeout(timer);
        this.stopBranchWatch = null;
        if (seg && gen === this.generation) {
          take(seg);
          this.report();
          if (this.playing) {
            // Continue playback from the new segment once the current run loop returns.
            setTimeout(() => void this.run(), 0);
          }
        }
        resolve();
      };
      this.stopBranchWatch = () => finish(null);
      if (ev.timeoutMs !== undefined && ev.default) timer = setTimeout(() => finish(ev.default!), ev.timeoutMs * this.speed);
    });
  }
}
