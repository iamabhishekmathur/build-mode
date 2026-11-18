/**
 * Side-by-side view (FR-405): 2–4 frames of the same URL, each in its own forked session.
 * `frames` is a JSON list of `{ label, sc }` where `sc` is a share-state param.
 */
export function comparePage(url: URL): string {
  const path = url.searchParams.get('url') ?? '/';
  let frames: { label: string; sc: string }[] = [];
  try {
    frames = JSON.parse(url.searchParams.get('frames') ?? '[]');
  } catch {
    frames = [];
  }
  frames = frames.slice(0, 4);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const src = (sc: string) => {
    const u = new URL(path, 'http://x');
    u.searchParams.set('__sc_session', 'fork');
    if (sc) u.searchParams.set('__sc', sc);
    u.searchParams.set('sc_panel', '0');
    return u.pathname + u.search;
  };
  const cells = frames
    .map((f, i) => `<figure><figcaption>${esc(f.label)}</figcaption><iframe title="${esc(f.label)}" data-i="${i}" src="${esc(src(f.sc))}"></iframe></figure>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stagecraft compare</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1b1b1b;--muted:#666;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#aaa;--line:#333}}
body{margin:0;font:13px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center}
main{display:grid;grid-template-columns:repeat(${Math.max(frames.length, 1)},1fr);gap:8px;padding:8px;height:calc(100vh - 50px);box-sizing:border-box}
figure{margin:0;display:flex;flex-direction:column;min-width:0}
figcaption{font-weight:600;padding:4px 2px}
iframe{flex:1;width:100%;border:1px solid var(--line);border-radius:6px;background:#fff}
</style></head><body>
<header><strong>Compare</strong><span style="color:var(--muted)">${esc(path)} · scroll and navigation are synced</span></header>
<main>${cells || '<p>No frames. Pass ?frames=[{"label":"A","sc":"..."}]</p>'}</main>
<script>
const frames=[...document.querySelectorAll('iframe')];let lock=false;
function hook(f){try{const w=f.contentWindow;w.addEventListener('scroll',()=>{if(lock)return;lock=true;for(const o of frames)if(o!==f)try{o.contentWindow.scrollTo(w.scrollX,w.scrollY)}catch{}requestAnimationFrame(()=>lock=false)});
let last=w.location.pathname;setInterval(()=>{try{const p=w.location.pathname;if(p!==last){last=p;for(const o of frames)if(o!==f&&o.contentWindow.location.pathname!==p){o.contentWindow.__STAGECRAFT__?.navigate(p)}}}catch{}},300)}catch{}}
frames.forEach(f=>f.addEventListener('load',()=>hook(f)));
</script></body></html>`;
}
