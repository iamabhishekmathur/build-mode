import { encodeShareState, type FaultRule, type Json } from '@stagecraft/core';
import type { StagecraftRuntime, TapeStatus } from './types.ts';
import { renderPins, startPicker, type Pick } from './feedback.ts';

const CSS = `
:host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light dark}
*{box-sizing:border-box}
.panel{--bg:#fff;--fg:#1a1a1a;--muted:#5f5f5f;--line:#e2e2e2;--soft:#f4f4f2;--accent:#3b4ee8;--accent-fg:#fff;--warn:#9a5b00;
  width:320px;max-height:min(80vh,720px);overflow:auto;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18)}
@media (prefers-color-scheme:dark){.panel{--bg:#1d1d1f;--fg:#ededed;--muted:#a3a3a3;--line:#353538;--soft:#28282b;--accent:#8a96ff;--accent-fg:#111;--warn:#f0b35a}}
.panel.hc{--line:currentColor;--muted:inherit}
header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:1}
header strong{flex:1;font-size:13px}
.sid{color:var(--muted);font-size:11px}
section{padding:10px 12px;border-bottom:1px solid var(--line)}
section:last-child{border-bottom:0}
h2{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 6px}
.row{display:flex;align-items:center;gap:8px;margin:4px 0}
.row>label{flex:0 0 96px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
select,input[type=text],input[type=range]{flex:1;min-width:0}
select,input[type=text]{font:inherit;color:var(--fg);background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:4px 6px}
button{font:inherit;color:var(--fg);background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:4px 8px;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
button.icon{padding:2px 8px}
button:disabled{opacity:.5;cursor:default}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.muted{color:var(--muted)}
.warn{color:var(--warn)}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.small{font-size:11px}
.handle{all:unset;cursor:pointer;display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:#3b4ee8;color:#fff;font:600 12px system-ui;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.handle:focus-visible{outline:2px solid #3b4ee8;outline-offset:3px}
pre{margin:6px 0 0;max-height:180px;overflow:auto;background:var(--soft);padding:6px;border-radius:6px;font-size:11px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (prefers-reduced-motion:no-preference){.panel{transition:opacity .12s}}
`;

type Mode = 'open' | 'collapsed' | 'hidden';

const FAULT_KINDS: Record<string, Omit<FaultRule, 'endpoint'> | null> = {
  none: null,
  'slow (2 s)': { latencyMs: 2000 },
  '500 error': { status: 500 },
  '504 timeout': { status: 504 },
  'no response': { timeout: true },
};

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
  return null;
}

function esc(s: unknown) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function mountPanel(rt: StagecraftRuntime, defaults: any) {
  const host = document.createElement('stagecraft-panel');
  host.setAttribute('data-stagecraft', '');
  const root = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);
  let mode: Mode = (store('stagecraft.panel') as Mode) || 'open';
  // Dock side: product UIs often put drawers on the right, so the viewer can move the panel.
  let dock: 'left' | 'right' = store('stagecraft.dock') === 'left' ? 'left' : 'right';
  const applyDock = () => {
    host.style.left = dock === 'left' ? '16px' : 'auto';
    host.style.right = dock === 'right' ? '16px' : 'auto';
  };
  let message = '';
  let busy = false;
  let dbView: string | null = null;
  // ---- feedback (FR-901..905) ----
  let comments: any[] = [];
  let draft: Pick | null = null;
  let picking: (() => void) | null = null;
  let focusComment: string | null = null;
  let sentPrompt = false;
  const pagePath = () => location.pathname;
  const pageComments = () => comments.filter((c) => new URL(c.url, location.href).pathname === pagePath() && !['resolved', 'wont_fix'].includes(c.status));
  async function loadComments() {
    try {
      comments = await rt.api('GET', '/feedback');
    } catch {
      comments = [];
    }
    drawPins();
    render();
  }
  function drawPins() {
    renderPins(pageComments(), (id) => {
      focusComment = id;
      if (mode !== 'open') setMode('open');
      else render();
      (root.querySelector(`[data-comment="${id}"]`) as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    }, mode !== 'hidden');
  }
  addEventListener('resize', () => drawPins());
  addEventListener('popstate', () => setTimeout(() => (drawPins(), render()), 50));
  function commentsSection() {
    const here = comments.filter((c) => new URL(c.url, location.href).pathname === pagePath());
    const open = comments.filter((c) => c.status === 'open');
    const status: Record<string, string> = { open: 'Open', sent: 'Sent to agent', agent_done: 'Agent replied', resolved: 'Resolved', wont_fix: "Won't fix" };
    const shot = (id: string, name?: string) => (name ? `<a href="/__stagecraft/api/feedback/${esc(id)}/shot/${esc(name)}.png" target="_blank" rel="noopener">${esc(name.startsWith('after') ? 'after' : 'before')}</a>` : '');
    const items = here
      .map((c, i) => {
        const n = pageComments().indexOf(c);
        const replies = c.replies
          .map((r: any) => `<div class="small" style="margin:4px 0 0 8px"><strong>${esc(r.author)}:</strong> ${esc(r.text)} ${shot(c.id, r.before)} ${shot(c.id, r.after)}${r.commit ? ` <span class="muted">${esc(r.commit)}</span>` : ''}</div>`)
          .join('');
        const human = c.status === 'resolved' || c.status === 'wont_fix'
          ? `<button data-k="fb-status:${esc(c.id)}:open">Reopen</button>`
          : `<button data-k="fb-status:${esc(c.id)}:resolved">Resolve</button><button data-k="fb-status:${esc(c.id)}:wont_fix">Won't fix</button>`;
        return `<div data-comment="${esc(c.id)}" style="padding:6px 0;border-top:1px solid var(--line)${focusComment === c.id ? ';background:var(--soft)' : ''}">
          <div class="small muted">${n >= 0 ? `#${n + 1} · ` : ''}${esc(status[c.status] ?? c.status)} · ${esc(c.author)}${c.source?.file ? ` · ${esc(c.source.file.split('/').slice(-2).join('/'))}${c.source.line ? ':' + c.source.line : ''}` : ''}</div>
          <div>${esc(c.text)} ${shot(c.id, c.screenshot)}</div>${replies}
          <div class="row">${human}</div></div>`;
      })
      .join('');
    const composer = draft
      ? `<div style="border:1px solid var(--accent);border-radius:8px;padding:8px;margin-bottom:6px">
          <div class="small muted">On ${esc(draft.label)}${draft.source?.file ? ` · ${esc(draft.source.file.split('/').slice(-2).join('/'))}${draft.source.line ? ':' + draft.source.line : ''}` : ''}</div>
          <textarea data-k="fb-text" aria-label="Comment" rows="3" style="width:100%;font:inherit;margin:6px 0;color:var(--fg);background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:4px"></textarea>
          <div class="row"><input type="text" data-k="fb-author" aria-label="Your name" placeholder="Your name" value="${esc(store('stagecraft.author') ?? '')}"><button class="primary" data-k="fb-save">Comment</button><button data-k="fb-cancel">Cancel</button></div></div>`
      : '';
    const send = open.length
      ? `<div class="row"><button data-k="fb-send">Send ${open.length} open comment${open.length > 1 ? 's' : ''} to agent</button></div>`
      : '';
    const prompt = sentPrompt ? `<div class="small">Sent. In your agent, say: <code>Handle the Stagecraft feedback</code> <button class="icon" data-k="fb-copy-prompt" aria-label="Copy prompt">⧉</button></div>` : '';
    if (!composer && !here.length && !open.length && !prompt) return '';
    return `<section aria-labelledby="h-fb"><h2 id="h-fb">Comments${here.length ? ` (${here.length} on this page)` : ''}</h2>${composer}${items}${send}${prompt}</section>`;
  }

  const setMode = (m: Mode) => {
    mode = m;
    store('stagecraft.panel', m);
    render();
    drawPins();
  };

  // Alt+Shift+S toggles hidden <-> open.
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'S' || e.code === 'KeyS')) {
      e.preventDefault();
      setMode(mode === 'hidden' ? 'open' : 'hidden');
    }
  });

  async function run(label: string, fn: () => Promise<unknown>) {
    busy = true;
    message = '';
    render();
    try {
      await fn();
      message = label;
    } catch (err) {
      message = `⚠ ${(err as Error).message}`;
    } finally {
      busy = false;
      render();
    }
  }

  function linkFor(extra: Record<string, string> = {}) {
    const u = new URL(location.href);
    u.searchParams.delete('__sc_session');
    const sc = encodeShareState(rt.info.state, defaults);
    if (sc) u.searchParams.set('__sc', sc);
    else u.searchParams.delete('__sc');
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.href;
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      message = label;
    } catch {
      message = text;
    }
    render();
  }

  function tapeSection(st: TapeStatus | null, tapes: any[]) {
    if (!tapes.length) return '';
    const opts = tapes.map((t) => `<option value="${esc(t.id)}" ${st?.id === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
    let timeline = '';
    if (st) {
      const outline = tapes.find((t) => t.id === st.id)?.outline?.find((o: any) => o.segment === st.segment);
      const stepLabel = outline?.steps?.[st.index - 1]?.label ?? (st.index === 0 ? 'Start' : '');
      const wait = st.waiting === 'branch' ? '<span class="warn">Waiting for an action in the UI</span>' : st.waiting === 'retry' ? '<span class="warn">Timed out. Waiting for the UI to retry</span>' : st.done ? 'Done' : '';
      timeline = `
        <div class="row">
          <button class="icon" data-k="tape-restart" aria-label="Restart tape">⏮</button>
          <button class="icon" data-k="tape-toggle" aria-label="${st.playing ? 'Pause' : 'Play'}">${st.playing ? '⏸' : '▶'}</button>
          <button class="icon" data-k="tape-step" aria-label="Step forward" ${st.waiting || st.done ? 'disabled' : ''}>⏭</button>
          <input type="range" data-k="tape-scrub" min="0" max="${st.total}" value="${st.index}" aria-label="Tape position in ${esc(st.segment)}">
        </div>
        <div class="small muted" aria-live="polite">${esc(st.segment === 'main' ? '' : `Branch ${st.segment} · `)}Step ${st.index}/${st.total}${stepLabel ? ` · ${esc(stepLabel)}` : ''}</div>
        <div class="small">${wait}</div>
        <div class="row"><button data-k="tape-link">Copy link to this step</button><button data-k="tape-stop">Stop</button></div>`;
    }
    return `<section aria-labelledby="h-tape"><h2 id="h-tape">Tape</h2>
      <div class="row"><label for="tape">Tape</label><select id="tape" data-k="tape-select"><option value="">—</option>${opts}</select></div>${timeline}</section>`;
  }

  function render() {
    const active = root.activeElement as HTMLElement | null;
    const focusKey = active?.getAttribute('data-k');
    host.style.display = mode === 'hidden' ? 'none' : '';
    applyDock();
    if (mode === 'hidden') {
      root.innerHTML = '';
      return;
    }
    if (mode === 'collapsed') {
      root.innerHTML = `<style>${CSS}</style><button class="handle" data-k="expand" aria-label="Open Stagecraft panel">SC</button>`;
      root.querySelector('[data-k=expand]')!.addEventListener('click', () => setMode('open'));
      if (focusKey) (root.querySelector(`[data-k="${focusKey}"]`) as HTMLElement | null)?.focus();
      return;
    }
    const c = rt.catalog;
    const st = rt.info.state;
    const flags = rt.info.flags;
    const personaOpts = Object.entries(c.personas)
      .map(([k, p]: [string, any]) => `<option value="${esc(k)}" ${st.persona === k ? 'selected' : ''}>${esc(p.label)}</option>`)
      .join('');
    const stateRows = Object.entries(c.states)
      .map(([entity, def]: [string, any]) => {
        const o = Object.entries(def.states)
          .map(([k, s]: [string, any]) => `<option value="${esc(k)}" ${st.states[entity] === k ? 'selected' : ''}>${esc(s.label ?? k)}</option>`)
          .join('');
        return `<div class="row"><label for="st-${esc(entity)}">${esc(def.label ?? entity)}</label><select id="st-${esc(entity)}" data-k="state:${esc(entity)}">${o}</select></div>`;
      })
      .join('');
    const flagRows = Object.entries(c.flags)
      .map(([k, def]: [string, any]) => {
        const v = flags[k];
        const id = `fl-${esc(k)}`;
        const overridden = k in st.flags;
        const label = `<label for="${id}" title="${esc(def.description ?? k)}">${esc(k)}${overridden ? ' •' : ''}</label>`;
        if (typeof def.default === 'boolean' && !def.options) {
          return `<div class="row">${label}<input type="checkbox" id="${id}" data-k="flag:${esc(k)}" ${v ? 'checked' : ''}></div>`;
        }
        const options: Json[] = def.options ?? [def.default];
        return `<div class="row">${label}<select id="${id}" data-k="flag:${esc(k)}">${options.map((o) => `<option value='${esc(JSON.stringify(o))}' ${JSON.stringify(o) === JSON.stringify(v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
      })
      .join('');
    const variantEntries = Object.entries(c.variants ?? {}) as [string, string[]][];
    const variantRows = variantEntries
      .map(([name, options]) => {
        const cur = st.variants[name] ?? options[0];
        return `<div class="row"><label for="va-${esc(name)}">${esc(name)}</label><select id="va-${esc(name)}" data-k="variant:${esc(name)}">${options.map((o) => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select><button class="icon" data-k="compare:${esc(name)}" aria-label="Compare ${esc(name)} side by side">⇆</button></div>`;
      })
      .join('');
    const scenarioOpts = (c.scenarios ?? []).map((s: any) => `<option value="${esc(s.name)}" ${st.scenario === s.name ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    const faults = st.faults
      .map((f, i) => `<div class="row small"><span style="flex:1">${esc(f.endpoint)} → ${esc(f.timeout ? 'no response' : f.status ?? `${f.latencyMs} ms`)}</span><button class="icon" data-k="fault-del:${i}" aria-label="Remove fault on ${esc(f.endpoint)}">✕</button></div>`)
      .join('');
    root.innerHTML = `<style>${CSS}</style>
    <div class="panel" role="region" aria-label="Stagecraft preview panel" ${busy ? 'aria-busy="true"' : ''}>
      <header><strong>Stagecraft</strong><span class="sid">${rt.sessionId === 'main' ? '' : esc(rt.sessionId)}</span>
        <button class="icon" data-k="comment" aria-label="${picking ? 'Cancel comment' : 'Add a comment: pick an element or drag a box'}" aria-pressed="${picking ? 'true' : 'false'}">💬</button>
        <button class="icon" data-k="copy-link" aria-label="Copy link to this view">🔗</button>
        <button class="icon" data-k="dock" aria-label="Move panel to the ${dock === 'right' ? 'left' : 'right'} side">${dock === 'right' ? '⇤' : '⇥'}</button>
        <button class="icon" data-k="collapse" aria-label="Collapse panel">–</button>
        <button class="icon" data-k="hide" aria-label="Hide panel (Alt+Shift+S to show)">✕</button></header>
      ${commentsSection()}
      <section aria-labelledby="h-who"><h2 id="h-who">Who</h2>
        <div class="row"><label for="persona">Persona</label><select id="persona" data-k="persona">${personaOpts}</select></div></section>
      ${stateRows ? `<section aria-labelledby="h-states"><h2 id="h-states">States</h2>${stateRows}</section>` : ''}
      ${flagRows ? `<section aria-labelledby="h-flags"><h2 id="h-flags">Flags</h2>${flagRows}</section>` : ''}
      ${variantRows ? `<section aria-labelledby="h-var"><h2 id="h-var">Variants</h2>${variantRows}</section>` : ''}
      <section aria-labelledby="h-sc"><h2 id="h-sc">Scenarios</h2>
        <div class="row"><label for="sc">Load</label><select id="sc" data-k="scenario"><option value="">—</option>${scenarioOpts}</select></div>
        <div class="row"><input type="text" data-k="scenario-name" aria-label="New scenario name" placeholder="Save current setup as…"><button data-k="scenario-save">Save</button></div></section>
      ${tapeSection(rt.info.tape, c.tapes ?? [])}
      <section aria-labelledby="h-faults"><h2 id="h-faults">Faults</h2>${faults}
        <div class="row"><select data-k="fault-endpoint" aria-label="Endpoint">${(c.endpoints ?? []).map((e: string) => `<option>${esc(e)}</option>`).join('')}</select>
        <select data-k="fault-kind" aria-label="Fault">${Object.keys(FAULT_KINDS).map((k) => `<option>${esc(k)}</option>`).join('')}</select>
        <button data-k="fault-add" aria-label="Add fault">Add</button></div></section>
      <section aria-labelledby="h-db"><h2 id="h-db">Mock DB</h2>
        <div class="row"><button data-k="db-view">${dbView === null ? 'View' : 'Hide'}</button><button data-k="db-reset">Reset to seed + states</button></div>
        ${dbView !== null ? `<pre>${esc(dbView)}</pre>` : ''}</section>
      <div class="sr" aria-live="polite">${esc(message)}</div>
      ${message ? `<section class="small ${message.startsWith('⚠') ? 'warn' : 'muted'}">${esc(message)}</section>` : ''}
    </div>`;
    wire();
    if (focusKey) (root.querySelector(`[data-k="${focusKey}"]`) as HTMLElement | null)?.focus();
  }

  function wire() {
    const on = (k: string, ev: string, fn: (el: any) => void) => root.querySelectorAll(`[data-k^="${k}"]`).forEach((el) => el.addEventListener(ev, () => fn(el)));
    on('copy-link', 'click', () => copy(linkFor(), 'Link copied'));
    on('comment', 'click', () => {
      if (picking) {
        picking();
        picking = null;
        return render();
      }
      draft = null;
      picking = startPicker(
        (p) => {
          picking = null;
          draft = p;
          render();
          (root.querySelector('[data-k=fb-text]') as HTMLElement | null)?.focus();
        },
        () => {
          picking = null;
          render();
        },
      );
      message = 'Click an element or drag a box. Esc cancels.';
      render();
    });
    on('fb-cancel', 'click', () => {
      draft = null;
      render();
    });
    on('fb-save', 'click', () => {
      const text = (root.querySelector('[data-k=fb-text]') as HTMLTextAreaElement).value;
      const author = (root.querySelector('[data-k=fb-author]') as HTMLInputElement).value.trim();
      if (author) store('stagecraft.author', author);
      const d = draft!;
      run('Comment saved', async () => {
        await rt.api('POST', '/feedback', { text, author, url: location.pathname + location.search, viewport: { width: innerWidth, height: innerHeight }, anchor: { kind: d.kind, selector: d.selector, text: d.text, box: d.box }, source: d.source });
        draft = null;
        await loadComments();
      });
    });
    on('fb-status:', 'click', (el) => {
      const [, id, status] = el.dataset.k.split(':');
      run('Comment updated', async () => {
        await rt.api('PATCH', `/feedback/${id}`, { status, author: store('stagecraft.author') ?? undefined });
        await loadComments();
      });
    });
    on('fb-send', 'click', () =>
      run('Sent to agent', async () => {
        await rt.api('POST', '/feedback/send', {});
        sentPrompt = true;
        await loadComments();
      }),
    );
    on('fb-copy-prompt', 'click', () => copy('Handle the Stagecraft feedback', 'Prompt copied'));
    on('collapse', 'click', () => setMode('collapsed'));
    on('dock', 'click', () => {
      dock = dock === 'right' ? 'left' : 'right';
      store('stagecraft.dock', dock);
      render();
    });
    on('hide', 'click', () => setMode('hidden'));
    on('persona', 'change', (el) => run('Persona changed', () => rt.set({ persona: el.value })));
    on('state:', 'change', (el) => run('State changed', () => rt.set({ states: { [el.dataset.k.slice(6)]: el.value } })));
    on('flag:', 'change', (el) => {
      const k = el.dataset.k.slice(5);
      const v = el.type === 'checkbox' ? el.checked : JSON.parse(el.value);
      run('Flag changed', () => rt.set({ flags: { [k]: v } }));
    });
    on('variant:', 'change', (el) => run('Variant changed', () => rt.set({ variants: { [el.dataset.k.slice(8)]: el.value } })));
    on('compare:', 'click', (el) => {
      const name = el.dataset.k.slice(8);
      const options: string[] = rt.catalog.variants[name];
      const frames = options.map((o) => ({ label: `${name}: ${o}`, sc: encodeShareState({ ...rt.info.state, variants: { ...rt.info.state.variants, [name]: o } }, defaults) }));
      const u = new URL('/__stagecraft/compare', location.href);
      u.searchParams.set('url', location.pathname);
      u.searchParams.set('frames', JSON.stringify(frames));
      window.open(u.href, '_blank', 'noopener');
    });
    on('scenario', 'change', (el) => {
      if (el.dataset.k !== 'scenario' || !el.value) return;
      run(`Loaded "${el.value}"`, async () => {
        const out = await rt.api<{ url?: string }>('POST', '/scenarios/load', { name: el.value });
        if (out.url && out.url !== location.pathname) rt.navigate(out.url);
      });
    });
    on('scenario-save', 'click', () => {
      const input = root.querySelector('[data-k=scenario-name]') as HTMLInputElement;
      const name = input.value.trim();
      if (!name) {
        message = '⚠ Type a scenario name first';
        return render();
      }
      run(`Saved "${name}" to the repo`, async () => {
        await rt.api('POST', '/scenarios', { name, url: location.pathname });
        const cat = await rt.api('GET', '/catalog');
        Object.assign(rt.catalog, { scenarios: cat.scenarios });
      });
    });
    on('tape-select', 'change', (el) =>
      run(el.value ? 'Tape loaded' : 'Tape stopped', () => (el.value ? rt.api('POST', '/tape/load', { id: el.value }) : rt.api('POST', '/tape/control', { action: 'stop' }))),
    );
    on('tape-toggle', 'click', () => run('', () => rt.api('POST', '/tape/control', { action: rt.info.tape?.playing ? 'pause' : 'play' })));
    on('tape-step', 'click', () => run('', () => rt.api('POST', '/tape/control', { action: 'step' })));
    on('tape-restart', 'click', () => run('', () => rt.api('POST', '/tape/load', { id: rt.info.tape!.id, at: '0', autoplay: false })));
    on('tape-stop', 'click', () => run('Tape stopped', () => rt.api('POST', '/tape/control', { action: 'stop' })));
    on('tape-scrub', 'change', (el) => {
      const t = rt.info.tape!;
      const at = t.segment === 'main' ? el.value : `${t.segment}:${el.value}`;
      run('', () => rt.api('POST', '/tape/load', { id: t.id, at, autoplay: false }));
    });
    on('tape-link', 'click', () => {
      const t = rt.info.tape!;
      copy(linkFor({ sc_tape: t.id, sc_step: t.at }), `Link to step ${t.at} copied`);
    });
    on('fault-add', 'click', () => {
      const endpoint = (root.querySelector('[data-k=fault-endpoint]') as HTMLSelectElement).value;
      const kind = FAULT_KINDS[(root.querySelector('[data-k=fault-kind]') as HTMLSelectElement).value];
      if (!endpoint) return;
      const rest = rt.info.state.faults.filter((f) => f.endpoint !== endpoint);
      run('Faults updated', () => rt.set({ faults: kind ? [...rest, { endpoint, ...kind }] : rest }));
    });
    on('fault-del:', 'click', (el) => {
      const i = Number(el.dataset.k.slice(10));
      run('Fault removed', () => rt.set({ faults: rt.info.state.faults.filter((_, j) => j !== i) }));
    });
    on('db-view', 'click', async () => {
      if (dbView !== null) {
        dbView = null;
        return render();
      }
      const out = await rt.api('GET', '/mockdb');
      dbView = JSON.stringify(out.value, null, 2);
      render();
    });
    on('db-reset', 'click', () => run('Mock DB reset', () => rt.api('POST', '/mockdb/reset')));
  }

  const refreshDb = async () => {
    if (dbView === null) return;
    const out = await rt.api('GET', '/mockdb');
    dbView = JSON.stringify(out.value, null, 2);
    render();
  };
  rt.on('feedback', () => void loadComments());
  rt.on('navigate', () => setTimeout(() => (drawPins(), render()), 50));
  rt.on('data', () => setTimeout(drawPins, 300));
  rt.on('data', render);
  rt.on('ui', render);
  rt.on('tape', render);
  rt.on('catalog', render);
  rt.on('db', () => void refreshDb());
  render();
  void loadComments();
}
