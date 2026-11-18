import type { EntityStates, Json, JsonObject, StateCatalog } from './types.ts';

// Deterministic fake data for mock DBs (FR-502, FR-506). No dependencies: the same seed gives the same data
// on every machine, so generated seeds, scenarios and screenshots stay stable.

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** Float in [min, max) rounded to `decimals`. */
  float(min: number, max: number, decimals?: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
  /** Lowercase hex string of `length` chars. */
  hex(length: number): string;
}

/** Seeded PRNG (mulberry32). */
export function createRng(seed = 1): Rng {
  let a = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max, decimals = 2) => Number((min + next() * (max - min)).toFixed(decimals)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    bool: (p = 0.5) => next() < p,
    hex: (n) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join(''),
  };
  return rng;
}

export const FAKE = {
  firstNames: ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Katherine', 'Dennis', 'Barbara', 'Tim', 'Radia', 'Hedy', 'Edsger', 'Frances', 'Ken', 'Sophie', 'Yuki', 'Amara', 'Mateo', 'Priya', 'Omar'],
  lastNames: ['Okafor', 'Hopper', 'Turing', 'Lindqvist', 'Hamilton', 'Johnson', 'Ritchie', 'Liskov', 'Berners-Lee', 'Perlman', 'Lamarr', 'Dijkstra', 'Allen', 'Thompson', 'Wilson', 'Tanaka', 'Mensah', 'García', 'Raman', 'Haddad'],
  companies: ['Northwind Supplies', 'Globex Hosting', 'Initech', 'Umbrella Logistics', 'Soylent Catering', 'Hooli', 'Vandelay Industries', 'Stark Freight', 'Wayne Analytics', 'Acme Robotics', 'Cyberdyne Labs', 'Tyrell Biotech'],
  suffixes: ['Inc.', 'LLC', 'Ltd.', 'GmbH', 'Co.'],
  words: ['quarterly', 'invoice', 'renewal', 'hardware', 'consulting', 'design', 'support', 'license', 'travel', 'onboarding', 'analytics', 'migration', 'review', 'workshop', 'subscription', 'maintenance', 'shipping', 'catering'],
  cities: ['Berlin', 'Lagos', 'Austin', 'Toronto', 'Lisbon', 'Osaka', 'Melbourne', 'Nairobi', 'Bogotá', 'Stockholm'],
  streets: ['Market Street', 'Elm Avenue', 'Harbour Road', 'King Street', 'Maple Drive', 'Station Road'],
  countries: ['US', 'DE', 'GB', 'FR', 'NG', 'JP', 'CA', 'BR', 'IN', 'SE'],
  countryNames: ['United States', 'Germany', 'United Kingdom', 'France', 'Nigeria', 'Japan', 'Canada', 'Brazil', 'India', 'Sweden'],
  currencies: ['USD', 'EUR', 'GBP', 'JPY', 'CAD'],
  roles: ['admin', 'member', 'viewer'],
  timezones: ['Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Africa/Lagos', 'America/Los_Angeles'],
  locales: ['en-US', 'de-DE', 'fr-FR', 'ja-JP', 'pt-BR'],
  colors: ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2'],
  domains: ['example.com', 'example.org', 'example.net'],
} as const;

/** Strings that break layouts. Used by the edge presets (FR-506). */
export const EDGE_TEXT = {
  long:
    'Consolidated quarterly maintenance, support and licensing renewal for all regional offices including the extended hardware warranty, ' +
    'on-site onboarding workshops, travel and accommodation for three consultants, shipping of replacement parts, and the analytics add-on ' +
    'that finance asked to keep for one more cycle while procurement reviews alternatives — ' +
    'Pneumonoultramicroscopicsilicovolcanoconiosis_without_any_breaking_opportunity_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  rtl: [
    'شركة النور للتجارة والمقاولات المحدودة',
    'חברת אור לים בע״מ — חשבונית מס׳ 2026',
    'فاتورة رقم ٢٠٢٦-١١٤ لشركة Acme Robotics',
    'שירותי ייעוץ וניהול פרויקטים',
    'محمد عبد الرحمن الحسيني',
  ],
  unicode: [
    '🚀 Launch team 👩🏽‍💻👨‍👩‍👧 🇯🇵',
    'Z̤͔ͧ̑̓ä͖̭̈̇lͮ̒ͫǧ̗͚̚o̙̔ͮ̇͐̇ combining marks',
    '株式会社東京商事 — 請求書',
    '서울 무역 주식회사',
    'Ünïcödé naïve café — Ångström Øresund',
    'Zero​width spaces and  thin spaces',
  ],
} as const;

const BASE_DATE = Date.UTC(2026, 10, 15); // 2026-11-15, fixed so output never depends on "now"
const DAY = 86_400_000;

export interface FakeHint {
  /** JSON type: string, integer, number, boolean. */
  type: 'string' | 'integer' | 'number' | 'boolean';
  format?: string;
  enum?: readonly Json[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  /** Position of the record in its collection. */
  index?: number;
  /** Type of the record that holds the field, e.g. `Invoice` (makes `name`, `number` realistic). */
  entity?: string;
}

const norm = (s: string) => s.replace(/[_\-\s]/g, '').toLowerCase();
/** `id`, `customerId`, `customer_id`, `customerID`. */
export const isIdField = (field: string) => /^(id|ID|_id)$|[a-z0-9](Id|ID|_id)$/.test(field);

export function fakeName(r: Rng) {
  return `${r.pick(FAKE.firstNames)} ${r.pick(FAKE.lastNames)}`;
}

export function fakeCompany(r: Rng) {
  return `${r.pick(FAKE.companies)} ${r.pick(FAKE.suffixes)}`;
}

export function fakeEmail(r: Rng, name = fakeName(r)) {
  const local = name
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.');
  return `${local || 'user'}${r.int(1, 99)}@${r.pick(FAKE.domains)}`;
}

export function fakeDateTime(r: Rng, pastDays = 365) {
  return new Date(BASE_DATE - r.int(0, pastDays * 24) * 3_600_000 - r.int(0, 59) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function fakeDate(r: Rng, pastDays = 365) {
  return new Date(BASE_DATE - r.int(0, pastDays) * DAY).toISOString().slice(0, 10);
}

export function fakeUuid(r: Rng) {
  const h = r.hex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[r.int(0, 3)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function fakeSentence(r: Rng, words = r.int(4, 9)) {
  const w = Array.from({ length: words }, () => r.pick(FAKE.words));
  const s = w.join(' ');
  return s[0]!.toUpperCase() + s.slice(1) + '.';
}

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * A realistic value for a field, from its name and JSON type. Deterministic for a given Rng state.
 * Enums: the first value is the most common, so lists look like real data with a few outliers.
 */
export function fakeValue(r: Rng, field: string, hint: FakeHint): Json {
  const n = norm(field);
  if (hint.enum && hint.enum.length) {
    if (hint.index === 0 || hint.enum.length === 1) return hint.enum[0]!;
    return r.bool(0.5) ? hint.enum[0]! : r.pick(hint.enum);
  }
  if (hint.type === 'boolean') {
    if (/^(is|has)?(deleted|archived|disabled|blocked|locked|suspended)$/.test(n)) return r.bool(0.1);
    return r.bool(0.7);
  }
  if (hint.type === 'integer' || hint.type === 'number') return fakeNumber(r, n, field, hint);
  return fakeString(r, n, field, hint);
}

function clamp(v: number, hint: FakeHint) {
  if (hint.minimum !== undefined && v < hint.minimum) v = hint.minimum;
  if (hint.maximum !== undefined && v > hint.maximum) v = hint.maximum;
  return v;
}

function fakeNumber(r: Rng, n: string, field: string, hint: FakeHint): number {
  const int = hint.type === 'integer';
  const range = (lo: number, hi: number) => {
    const min = hint.minimum ?? lo;
    const max = hint.maximum ?? Math.max(hi, min);
    return clamp(int ? r.int(Math.ceil(min), Math.floor(max)) : r.float(min, max, 2), hint);
  };
  if (isIdField(field)) return field === 'id' || field === 'ID' ? (hint.index ?? r.int(0, 999)) + 1 : r.int(1, 999);
  if (/cents$/.test(n)) return range(1_000, 500_000);
  if (/(amount|price|total|cost|balance|fee|subtotal|tax|salary|revenue|spend|limit|budget|value)/.test(n)) return int ? range(10, 5000) : range(10, 5000);
  if (/(quantity|qty|count|items|seats|units|number)/.test(n)) return range(1, 20);
  if (/(percent|percentage|rate|ratio|score|progress)/.test(n)) return int ? range(0, 100) : range(0, 1);
  if (/^age$/.test(n)) return range(18, 80);
  if (/year/.test(n)) return range(2018, 2026);
  if (/(lat|latitude)$/.test(n)) return r.float(-60, 70, 5);
  if (/(lng|lon|longitude)$/.test(n)) return r.float(-170, 170, 5);
  if (/(step|level|rank|position|order|priority|version)/.test(n)) return range(1, 5);
  if (/(duration|seconds|minutes|ms)$/.test(n)) return range(1, 600);
  if (/(timestamp|epoch)/.test(n)) return Math.floor((BASE_DATE - r.int(0, 365) * DAY) / 1000);
  return range(1, 1000);
}

function fakeString(r: Rng, n: string, field: string, hint: FakeHint): string {
  const s = fakeStringRaw(r, n, field, hint);
  return hint.maxLength !== undefined && s.length > hint.maxLength ? s.slice(0, hint.maxLength) : s;
}

function fakeStringRaw(r: Rng, n: string, field: string, hint: FakeHint): string {
  switch (hint.format) {
    case 'date-time':
      return fakeDateTime(r);
    case 'date':
      return fakeDate(r);
    case 'time':
      return `${String(r.int(8, 18)).padStart(2, '0')}:${r.pick(['00', '15', '30', '45'])}:00`;
    case 'email':
      return fakeEmail(r);
    case 'uuid':
      return fakeUuid(r);
    case 'uri':
    case 'url':
    case 'iri':
      return /(avatar|image|photo|picture|logo|icon)/.test(n) ? `https://picsum.photos/seed/${r.hex(6)}/200` : `https://${r.pick(FAKE.domains)}/${r.pick(FAKE.words)}/${r.hex(6)}`;
    case 'hostname':
      return `${r.pick(FAKE.words)}.${r.pick(FAKE.domains)}`;
    case 'ipv4':
      return `10.${r.int(0, 255)}.${r.int(0, 255)}.${r.int(1, 254)}`;
    case 'ipv6':
      return `fd00::${r.hex(4)}:${r.hex(4)}`;
    case 'password':
      return 'correct-horse-battery-staple';
    case 'byte':
      return 'ZmFrZQ==';
  }
  if (n === 'id' || n === 'uuid' || n === 'guid') return fakeUuid(r);
  if (/(timestamp|datetime)$/.test(n) || /[a-z0-9](At|_at|Time|_time)$/.test(field) || /^(created|updated|modified)$/.test(n)) return fakeDateTime(r);
  if (/(date|dob|birthday|birthdate)$/.test(n) || /[a-z0-9](On|_on)$/.test(field) || /^(due|start|end|expires?|expiry)$/.test(n)) return fakeDate(r);
  if (isIdField(field)) return `${n.slice(0, 3)}_${r.hex(8)}`;
  const entity = norm(hint.entity ?? '');
  if (/^(last4|lastfour|lastdigits)$/.test(n)) return String(r.int(0, 9999)).padStart(4, '0');
  if (/iban/.test(n)) return `DE${r.int(10, 99)} 3704 0044 ${r.int(1000, 9999)} ${r.int(1000, 9999)} ${r.int(10, 99)}`;
  if (n === 'name' && /(account|org|organi[sz]ation|company|workspace|team|vendor|merchant|tenant|business|supplier|brand|store|shop)/.test(entity)) return fakeCompany(r);
  if (n === 'name' && /(product|plan|project|item|feature|service|app|campaign|category|tag|label|board|channel|folder|group|line)/.test(entity)) return titleCase(`${r.pick(FAKE.words)} ${r.pick(FAKE.words)}`);
  if (/^(number|no|num)$/.test(n) && entity) return `${entity.slice(0, 3).toUpperCase()}-${1001 + (hint.index ?? r.int(0, 900))}`;
  if (/email/.test(n)) return fakeEmail(r);
  if (/^(first|given)name$/.test(n)) return r.pick(FAKE.firstNames);
  if (/^(last|family|sur)name$/.test(n)) return r.pick(FAKE.lastNames);
  if (/(company|organization|organisation|org|vendor|merchant|supplier|customer|business|employer|payee)(name)?$/.test(n)) return fakeCompany(r);
  if (/username|handle|login/.test(n)) return `${r.pick(FAKE.firstNames).toLowerCase()}${r.int(1, 99)}`;
  if (/(name|fullname|displayname|owner|author|assignee|contact|requestedby|createdby)$/.test(n)) return fakeName(r);
  if (/(phone|mobile|tel|fax)/.test(n)) return `+1 555 ${String(r.int(100, 999))} ${String(r.int(1000, 9999))}`;
  if (/(avatar|image|photo|picture|logo|icon|thumbnail)/.test(n)) return `https://picsum.photos/seed/${r.hex(6)}/200`;
  if (/(url|uri|link|website|homepage|href)$/.test(n)) return `https://${r.pick(FAKE.domains)}/${r.pick(FAKE.words)}`;
  if (/countrycode/.test(n) || (/country/.test(n) && hint.maxLength !== undefined && hint.maxLength <= 3)) return r.pick(FAKE.countries);
  if (/country/.test(n)) return r.pick(FAKE.countryNames);
  if (/city|town/.test(n)) return r.pick(FAKE.cities);
  if (/(street|address|line1|addressline)/.test(n)) return `${r.int(1, 240)} ${r.pick(FAKE.streets)}`;
  if (/(zip|postal|postcode)/.test(n)) return String(r.int(10000, 99999));
  if (/(state|region|province)$/.test(n)) return r.pick(['CA', 'NY', 'TX', 'WA', 'ON', 'BY']);
  if (/currency/.test(n)) return r.pick(FAKE.currencies);
  if (/(locale|language|lang)$/.test(n)) return r.pick(FAKE.locales);
  if (/(timezone|tz)$/.test(n)) return r.pick(FAKE.timezones);
  if (/(color|colour)$/.test(n)) return r.pick(FAKE.colors);
  if (/status$/.test(n)) return hint.index === 0 ? 'active' : r.pick(['active', 'active', 'active', 'pending', 'inactive']);
  if (/role$/.test(n)) return r.pick(FAKE.roles);
  if (/(type|kind|category|plan|tier)$/.test(n)) return r.pick(['standard', 'standard', 'premium', 'basic']);
  if (/slug/.test(n)) return `${r.pick(FAKE.words)}-${r.pick(FAKE.words)}`;
  if (/(token|secret|key|hash|sha|signature)$/.test(n)) return r.hex(32);
  if (/(number|code|ref|reference|sku)$/.test(n)) return `${n.slice(0, 3).toUpperCase()}-${r.int(1000, 9999)}`;
  if (/(description|summary|bio|notes?|comment|body|content|message|memo|details|text|reason)$/.test(n)) return fakeSentence(r);
  if (/(title|subject|label|headline|heading)$/.test(n)) return titleCase(`${r.pick(FAKE.words)} ${r.pick(FAKE.words)}`);
  if (/ip(address)?$/.test(n)) return `10.${r.int(0, 255)}.${r.int(0, 255)}.${r.int(1, 254)}`;
  if (/version$/.test(n)) return `${r.int(1, 4)}.${r.int(0, 9)}.${r.int(0, 20)}`;
  return titleCase(`${r.pick(FAKE.words)} ${r.pick(FAKE.words)}`);
}

// ---------- edge presets (FR-506) ----------

/** Field names that hold human text (safe to replace with long / RTL / unicode strings). */
const TEXT_FIELD = /(name|title|subject|label|description|summary|bio|note|comment|body|content|message|memo|details|text|reason|vendor|merchant|company|customer|address|city|headline)s?$/i;
const NOT_TEXT = /(^id$|id$|uuid|email|url|uri|link|status|type|kind|currency|country|locale|date|at$|time|token|key|hash|color|slug|phone|code|role)/i;

/** String fields of a record that look like human text. */
export function textFieldsOf(item: object): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(item)) {
    if (typeof v !== 'string') continue;
    if (TEXT_FIELD.test(k) && !/(email|url|uri|id)$/i.test(k)) out.push(k);
  }
  if (out.length) return out;
  return Object.entries(item)
    .filter(([k, v]) => typeof v === 'string' && !NOT_TEXT.test(k) && !/^\d{4}-\d{2}-\d{2}/.test(v))
    .map(([k]) => k);
}

export interface EdgeStatesOptions<T> {
  /** Catalog entity key. Default: the collection path. */
  entity?: string;
  label?: string;
  /** Rows in the `many` state. Default 1200. */
  many?: number;
  /** String fields to fill with edge text. Default: fields that look like human text. */
  textFields?: string[];
  /** Records used for `seeded` (the default state) and as the base of the text states. */
  baseline?: T[] | (() => T[]);
  /** Field that must stay unique across generated rows. Default `id`. */
  idField?: string;
  seed?: number;
}

/**
 * State catalog entry with edge presets for a collection in the mock DB:
 * `seeded` (default), `empty`, `one`, `many` (1,000+ rows), `long-text`, `rtl` and `unicode`.
 *
 * ```ts
 * export const states = defineStates({
 *   ...edgeStates('invoices', (i) => ({ id: `inv_${i + 1}`, customer: 'Globex', amount: 120 + i })),
 *   account: { ... },
 * });
 * ```
 */
export function edgeStates<T extends object>(collection: string, makeItem: (index: number, rng: Rng) => T, opts: EdgeStatesOptions<T> = {}): StateCatalog {
  const rng = createRng(opts.seed ?? 1);
  const idField = opts.idField ?? 'id';
  const base = typeof opts.baseline === 'function' ? opts.baseline() : opts.baseline;
  const make = (i: number) => ({ ...(makeItem(i, rng) as unknown as JsonObject) });
  const rows = (n: number) => Array.from({ length: n }, (_, i) => make(i));
  const textBase = (base && base.length ? (base as unknown as JsonObject[]).slice(0, 6).map((x) => ({ ...x })) : rows(5)) as JsonObject[];
  const fields = opts.textFields ?? (textBase[0] ? textFieldsOf(textBase[0]) : []);
  const withText = (pick: (row: number, field: number) => string) =>
    textBase.map((row, i) => {
      const out: JsonObject = { ...row };
      fields.forEach((f, j) => (out[f] = pick(i, j)));
      return out;
    });
  const many = rows(opts.many ?? 1200);
  if (idField && many.length && many.every((r) => idField in r)) {
    const seen = new Set<string>();
    many.forEach((r, i) => {
      const key = String(r[idField]);
      if (seen.has(key)) r[idField] = typeof r[idField] === 'number' ? i + 1 : `${key}-${i + 1}`;
      seen.add(String(r[idField]));
    });
  }
  const set = (value: Json) => ({ [collection]: { $set: value } });
  const label = opts.label ?? collection.replace(/[._]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
  const entry: EntityStates = {
    label,
    default: 'seeded',
    states: {
      seeded: { label: 'As seeded', db: base ? set(base as unknown as Json) : {} },
      empty: { label: 'Empty', description: 'No records: check the empty state', db: set([]) },
      one: { label: 'One item', db: set([make(0)]) },
      many: { label: `Many (${many.length.toLocaleString('en-US')})`, description: 'Check pagination, virtualisation and performance', db: set(many) },
      'long-text': { label: 'Very long text', description: `Long strings in ${fields.join(', ') || 'text fields'}`, db: set(withText(() => EDGE_TEXT.long)) },
      rtl: { label: 'Right-to-left text', description: 'Arabic and Hebrew strings', db: set(withText((i, j) => EDGE_TEXT.rtl[(i + j) % EDGE_TEXT.rtl.length]!)) },
      unicode: { label: 'Unicode', description: 'Emoji, combining marks, CJK, zero-width spaces', db: set(withText((i, j) => EDGE_TEXT.unicode[(i + j) % EDGE_TEXT.unicode.length]!)) },
    },
  };
  return { [opts.entity ?? collection]: entry };
}
