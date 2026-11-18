/** Element picker, source mapping and comment pins (FR-804, FR-901). */

export interface Pick {
  kind: 'element' | 'region';
  selector?: string;
  text?: string;
  box: { x: number; y: number; width: number; height: number };
  source?: { component?: string; file?: string; line?: number; framework?: string };
  label: string;
}

const OWN = (n: Node | null) => !!(n && (n as Element).closest?.('stagecraft-panel, stagecraft-overlay'));

function cssEscape(s: string) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

/** Stable-ish selector: data-testid / id when unique, else a tag path with :nth-of-type. */
export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    const tid = cur.getAttribute('data-testid');
    if (tid && document.querySelectorAll(`[data-testid="${tid}"]`).length === 1) {
      parts.unshift(`[data-testid="${tid}"]`);
      break;
    }
    if (cur.id && document.querySelectorAll(`#${cssEscape(cur.id)}`).length === 1) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const same = [...parent.children].filter((c) => c.tagName === cur!.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    cur = parent;
  }
  return parts.join(' > ');
}

/** "/src/pages/Payments.tsx:42" from a dev stack trace frame URL on this origin. */
function frameFromStack(stack: string): { file: string; line: number } | undefined {
  for (const line of stack.split('\n')) {
    const m = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/.exec(line);
    if (!m) continue;
    let u: URL;
    try {
      u = new URL(m[1]!);
    } catch {
      continue;
    }
    if (u.origin !== location.origin) continue;
    const p = decodeURIComponent(u.pathname);
    if (/node_modules|\/@vite\/|\/@react-refresh|\.vite\/deps|\/__stagecraft\/|_next\/static\/chunks\/(webpack|main|framework)/.test(p)) continue;
    return { file: p.replace(/^\/@fs/, ''), line: Number(m[2]) };
  }
  return undefined;
}

/** Component name and source location from framework dev metadata, when available. */
export function sourceOf(el: Element): Pick['source'] {
  // React (16–19): fiber on the DOM node.
  const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  if (fk) {
    const fiber: any = (el as any)[fk];
    let comp: any = fiber._debugOwner ?? fiber.return;
    while (comp && typeof comp.type !== 'function' && typeof comp.type?.render !== 'function') comp = comp._debugOwner ?? comp.return;
    const component = comp ? comp.type.displayName || comp.type.name || comp.type.render?.name : undefined;
    if (fiber._debugSource) return { framework: 'react', component, file: fiber._debugSource.fileName, line: fiber._debugSource.lineNumber };
    const stack = fiber._debugStack?.stack ?? (typeof fiber._debugStack === 'string' ? fiber._debugStack : '');
    const f = stack ? frameFromStack(stack) : undefined;
    return { framework: 'react', component, ...(f ?? {}) };
  }
  // Vue 3 dev: component instance on the element or an ancestor.
  for (let cur: any = el; cur; cur = cur.parentElement) {
    const inst = cur.__vueParentComponent;
    if (inst) return { framework: 'vue', component: inst.type?.__name ?? inst.type?.name, file: inst.type?.__file };
  }
  // Svelte dev.
  for (let cur: any = el; cur; cur = cur.parentElement) {
    if (cur.__svelte_meta?.loc) return { framework: 'svelte', file: cur.__svelte_meta.loc.file, line: cur.__svelte_meta.loc.line };
  }
  return undefined;
}

export function describe(el: Element): Pick {
  const r = el.getBoundingClientRect();
  const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const source = sourceOf(el);
  const tag = el.tagName.toLowerCase();
  const label = `${source?.component ? `<${source.component}> ` : ''}${tag}${text ? ` "${text.slice(0, 30)}"` : ''}`;
  return { kind: 'element', selector: selectorFor(el), text, box: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }, source, label };
}

/** Find a comment's element again after layout or content changes: selector + text, then text, then the stored box. */
export function locate(p: { selector?: string; text?: string; box: Pick['box']; kind: string }): DOMRect | Pick['box'] {
  if (p.kind === 'element') {
    const want = (p.text ?? '').slice(0, 24);
    const bySel = p.selector ? document.querySelector(p.selector) : null;
    const textOf = (e: Element) => ((e as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ');
    if (bySel && (!want || textOf(bySel).includes(want))) return toPage(bySel.getBoundingClientRect());
    if (want) {
      const tag = p.selector?.split('>').pop()?.trim().split(/[:[.#]/)[0];
      const cands = [...document.querySelectorAll(tag && /^[a-z0-9]+$/.test(tag) ? tag : 'body *')].filter((e) => !OWN(e) && textOf(e).startsWith(want));
      cands.sort((a, b) => textOf(a).length - textOf(b).length);
      if (cands[0]) return toPage(cands[0].getBoundingClientRect());
    }
    if (bySel) return toPage(bySel.getBoundingClientRect());
  }
  return p.box;
}

function toPage(r: DOMRect) {
  return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
}

/** Overlay host for the picker highlight and pins (separate from the panel so pins follow the page). */
export function overlay(): { root: ShadowRoot; host: HTMLElement } {
  let host = document.querySelector('stagecraft-overlay') as HTMLElement | null;
  if (!host) {
    host = document.createElement('stagecraft-overlay');
    host.setAttribute('style', 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646');
    host.attachShadow({ mode: 'open' }).innerHTML = `<style>
      .hl{position:fixed;pointer-events:none;border:2px solid #3b4ee8;background:rgba(59,78,232,.08);border-radius:4px;z-index:2}
      .tip{position:fixed;pointer-events:none;background:#1d1d1f;color:#fff;font:12px system-ui;padding:3px 6px;border-radius:4px;z-index:3;white-space:nowrap}
      .pin{all:unset;position:absolute;cursor:pointer;width:24px;height:24px;border-radius:50% 50% 50% 0;background:#e5484d;color:#fff;font:600 12px/24px system-ui;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3);z-index:1}
      .pin.sent{background:#3b4ee8}.pin.agent_done{background:#16794a}
      .pin:focus-visible{outline:2px solid #1d1d1f;outline-offset:2px}
      .shade{position:fixed;inset:0;cursor:crosshair;z-index:1}
    </style><div id="layer"></div>`;
    document.documentElement.appendChild(host);
  }
  return { root: host.shadowRoot!, host };
}

/**
 * Picker: hover highlights, click picks an element, drag draws a region. Esc cancels.
 * Runs in the capture phase so the app does not get the click.
 */
export function startPicker(onPick: (p: Pick) => void, onCancel: () => void): () => void {
  const { root } = overlay();
  const layer = root.getElementById('layer')!;
  const hl = document.createElement('div');
  hl.className = 'hl';
  const tip = document.createElement('div');
  tip.className = 'tip';
  layer.append(hl, tip);
  let start: { x: number; y: number } | null = null;
  let dragging = false;
  const target = (e: MouseEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && !OWN(el) ? el : null;
  };
  const show = (r: { left: number; top: number; width: number; height: number }, text: string) => {
    Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, display: 'block' });
    tip.textContent = text;
    Object.assign(tip.style, { left: `${r.left}px`, top: `${Math.max(0, r.top - 22)}px`, display: 'block' });
  };
  const move = (e: MouseEvent) => {
    if (start && (Math.abs(e.clientX - start.x) > 8 || Math.abs(e.clientY - start.y) > 8)) dragging = true;
    if (dragging && start) {
      show({ left: Math.min(start.x, e.clientX), top: Math.min(start.y, e.clientY), width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) }, 'Region');
      return;
    }
    const el = target(e);
    if (!el) return;
    const d = describe(el);
    show(el.getBoundingClientRect(), d.label + (d.source?.file ? ` · ${d.source.file.split('/').slice(-2).join('/')}${d.source.line ? ':' + d.source.line : ''}` : ''));
  };
  const down = (e: MouseEvent) => {
    if (OWN(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    start = { x: e.clientX, y: e.clientY };
    dragging = false;
  };
  const up = (e: MouseEvent) => {
    if (!start || OWN(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    const s = start;
    start = null;
    if (dragging) {
      const box = { x: Math.min(s.x, e.clientX) + scrollX, y: Math.min(s.y, e.clientY) + scrollY, width: Math.abs(e.clientX - s.x), height: Math.abs(e.clientY - s.y) };
      stop();
      onPick({ kind: 'region', box, label: `Region ${Math.round(box.width)}×${Math.round(box.height)}` });
      return;
    }
    const el = target(e);
    stop();
    if (el) onPick(describe(el));
    else onCancel();
  };
  const block = (e: Event) => {
    if (OWN(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      stop();
      onCancel();
    }
  };
  addEventListener('mousemove', move, true);
  addEventListener('mousedown', down, true);
  addEventListener('mouseup', up, true);
  addEventListener('click', block, true);
  addEventListener('keydown', key, true);
  document.documentElement.style.cursor = 'crosshair';
  function stop() {
    removeEventListener('mousemove', move, true);
    removeEventListener('mousedown', down, true);
    removeEventListener('mouseup', up, true);
    removeEventListener('keydown', key, true);
    // Swallow the click that follows this mouseup, then stop blocking.
    setTimeout(() => removeEventListener('click', block, true), 0);
    hl.remove();
    tip.remove();
    document.documentElement.style.cursor = '';
  }
  return stop;
}

/** Numbered pins for this page's open comments. */
export function renderPins(items: { id: string; status: string; anchor: any; text: string }[], onOpen: (id: string) => void, visible: boolean) {
  const { root } = overlay();
  const layer = root.getElementById('layer')!;
  layer.querySelectorAll('.pin').forEach((p) => p.remove());
  if (!visible) return;
  items.forEach((c, i) => {
    const b = locate(c.anchor);
    const pin = document.createElement('button');
    pin.className = `pin ${c.status}`;
    pin.textContent = String(i + 1);
    pin.setAttribute('aria-label', `Comment ${i + 1}: ${c.text}`);
    pin.title = c.text;
    pin.style.left = `${b.x + b.width - 12}px`;
    pin.style.top = `${b.y - 12}px`;
    pin.addEventListener('click', () => onOpen(c.id));
    layer.appendChild(pin);
  });
}
