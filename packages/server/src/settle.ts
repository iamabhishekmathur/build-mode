/**
 * Wait for a page to settle without `networkidle`, which never fires when a request
 * hangs (timeout faults), a stream stays open (tapes, the Stagecraft event stream),
 * or the app ignores an error body. Waits for no non-stream requests for `quietMs`,
 * capped at `maxMs`. Returns what was still in flight.
 */
export async function settle(page: any, opts: { quietMs?: number; maxMs?: number } = {}): Promise<string[]> {
  const quiet = opts.quietMs ?? 400;
  const max = opts.maxMs ?? 6000;
  const inflight = new Map<any, string>();
  const isStream = (r: any) => /\/__stagecraft\/api\/events|text\/event-stream/.test(r.url() + ' ' + (r.headers()['accept'] ?? '')) || r.resourceType() === 'eventsource' || r.resourceType() === 'websocket';
  const on = (r: any) => !isStream(r) && inflight.set(r, r.url());
  const off = (r: any) => inflight.delete(r);
  // A response with headers counts as done: apps often ignore error bodies, which then never "finish".
  page.on('request', on);
  page.on('response', off);
  page.on('requestfailed', off);
  const start = Date.now();
  let lastBusy = Date.now();
  try {
    while (Date.now() - start < max) {
      if (inflight.size) lastBusy = Date.now();
      else if (Date.now() - lastBusy >= quiet) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    page.off('request', on);
    page.off('response', off);
    page.off('requestfailed', off);
  }
  return [...inflight.values()];
}
