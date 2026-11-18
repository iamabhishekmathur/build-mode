/** Match `METHOD /path/:param/*` patterns. */
export interface Route<T> {
  key: string;
  method: string;
  re: RegExp;
  names: string[];
  value: T;
  specificity: number;
}

export function compile<T>(key: string, value: T): Route<T> {
  const m = /^\s*(\*|[A-Z]+)\s+(\S+)\s*$/.exec(key);
  if (!m) throw new Error(`Bad route key "${key}". Use "GET /api/things/:id".`);
  const names: string[] = [];
  let specificity = 0;
  const pattern = m[2]!
    .split('/')
    .map((part) => {
      if (part === '*') return '.*';
      if (part.startsWith(':')) {
        names.push(part.slice(1));
        return '([^/]+)';
      }
      specificity += 2;
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  if (m[1] !== '*') specificity += 1;
  return { key, method: m[1]!, re: new RegExp(`^${pattern}/?$`), names, value, specificity };
}

export function matchRoute<T>(routes: Route<T>[], method: string, path: string) {
  let best: { route: Route<T>; params: Record<string, string> } | null = null;
  for (const r of routes) {
    if (r.method !== '*' && r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    if (best && best.route.specificity >= r.specificity) continue;
    const params: Record<string, string> = {};
    r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
    best = { route: r, params };
  }
  return best;
}
