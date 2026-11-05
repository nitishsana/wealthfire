// Read card spend alert emails from Gmail and turn them into expenses.
// Platform-agnostic: web and mobile each get an OAuth access token their own way,
// then call syncGmail(). Only the read-only Gmail scope is used. Nothing leaves the device
// except the calls to Google's own API.
import type { Expense } from './types';
import { categorize, parseDate } from './expenses';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Gmail search for card spend alerts. Statement PDFs are not read yet. */
export function gmailQuery(days: number): string {
  return `(card) (spent OR debited OR "used for" OR "transaction of" OR "txn of") -otp -"one time password" newer_than:${Math.max(1, Math.round(days))}d`;
}

const SKIP = /\b(credited|refund(ed)?|reversal|reversed|payment received|payment of .* received|declined|failed|unsuccessful|otp|one time password|cashback)\b/i;
const SPEND = /\b(spent|debited|used for|used at|transaction of|txn of|purchase of|charged)\b/i;
const CARD = /\bcard\b/i;
const AMOUNT = /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d{1,2})?)/i;
const DATE_IN_TEXT = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\s-][A-Za-z]{3,9}[\s-,]+\d{2,4})\b/;
const MERCHANT_PATTERNS = [
  /\bat\s+(?![\d:]+\b)(.+?)(?:\s+on\s+\d|\s+on\s+[A-Za-z]{3}|\.\s|\.$|,|\s+avl|\s+available|\s+ref|\s+if not|$)/i,
  /\binfo[:\s]+(.+?)(?:\.\s|\.$|,|\s+avl|\s+available|$)/i,
  /\btowards\s+(.+?)(?:\s+on\s+\d|\.\s|\.$|,|$)/i,
  /\bmerchant(?: name)?[:\s]+(.+?)(?:\.\s|\.$|,|\n|$)/i,
];

export interface EmailLite {
  id: string;
  subject: string;
  body: string;
  /** ms since epoch, from Gmail internalDate */
  receivedAt: number;
}

function isoFromMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Turn one alert email into an expense, or null if it is not a card spend. */
export function parseCardAlert(mail: EmailLite): Expense | null {
  const text = `${mail.subject}. ${mail.body}`.replace(/\s+/g, ' ').trim();
  if (!CARD.test(text) || !SPEND.test(text) || SKIP.test(text)) return null;
  const am = text.match(AMOUNT);
  if (!am) return null;
  const amount = Number(am[1]!.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // Look for the merchant after the amount first, where alerts usually put it.
  const tail = text.slice((am.index ?? 0) + am[0].length);
  let merchant = '';
  for (const re of MERCHANT_PATTERNS) {
    const m = tail.match(re) ?? text.match(re);
    if (m && m[1]) { merchant = m[1].trim(); break; }
  }
  merchant = merchant.replace(/\s+on\s+.*$/i, '').replace(/[.\s]+$/, '').slice(0, 60) || 'Card spend';

  const dm = tail.match(DATE_IN_TEXT) ?? text.match(DATE_IN_TEXT);
  const date = (dm && parseDate(dm[1]!)) || isoFromMs(mail.receivedAt);

  return { id: `gm_${mail.id}`, date, description: merchant, amount, category: categorize(merchant), source: 'gmail' };
}

// ---------- tiny base64url + UTF-8 decoder (works in browsers and Hermes) ----------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function decodeBase64Url(input: string): string {
  const s = input.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff); }
  }
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]!;
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++]! & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8377;|&#x20b9;/gi, '₹').replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] }
interface GmailMessage { id: string; internalDate?: string; payload?: GmailPart }

/** Pick the plain-text body, else the HTML body as text. */
export function bodyFromPayload(p: GmailPart | undefined): string {
  if (!p) return '';
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: GmailPart) => {
    if (part.body?.data) {
      if (part.mimeType === 'text/plain') plain.push(decodeBase64Url(part.body.data));
      else if (part.mimeType === 'text/html') html.push(decodeBase64Url(part.body.data));
    }
    part.parts?.forEach(walk);
  };
  walk(p);
  return plain.length ? plain.join('\n') : htmlToText(html.join('\n'));
}

export function toEmailLite(m: GmailMessage): EmailLite {
  const subject = m.payload?.headers?.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
  return { id: m.id, subject, body: bodyFromPayload(m.payload), receivedAt: Number(m.internalDate ?? Date.now()) };
}

export class GmailAuthError extends Error {}

export interface SyncResult {
  scanned: number;
  added: Expense[];
  skipped: number;
  duplicates: number;
}

/** The slice of fetch we use, so core needs no DOM types. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export interface SyncOptions {
  days?: number; // how far back to look, default 90
  maxMessages?: number; // safety cap, default 300
  existingIds?: Set<string>;
  fetchFn?: FetchLike;
  onProgress?: (done: number, total: number) => void;
}

/** List alert emails, read each one, and return new expenses. */
export async function syncGmail(accessToken: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const f: FetchLike = opts.fetchFn ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const max = opts.maxMessages ?? 300;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const get = async (url: string) => {
    const r = await f(url, { headers });
    if (r.status === 401 || r.status === 403) throw new GmailAuthError('Gmail access expired or was denied. Connect again.');
    if (!r.ok) throw new Error(`Gmail error ${r.status}`);
    return r.json();
  };

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(gmailQuery(opts.days ?? 90));
    const url = `${API}/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = (await get(url)) as { messages?: { id: string }[]; nextPageToken?: string };
    for (const m of res.messages ?? []) ids.push(m.id);
    pageToken = res.nextPageToken;
  } while (pageToken && ids.length < max);

  const todo = ids.slice(0, max);
  const existing = opts.existingIds ?? new Set<string>();
  const added: Expense[] = [];
  let skipped = 0, duplicates = 0, done = 0;

  // Read 5 at a time to stay well under Gmail rate limits.
  for (let i = 0; i < todo.length; i += 5) {
    const batch = todo.slice(i, i + 5);
    const msgs = await Promise.all(batch.map((id) => {
      if (existing.has(`gm_${id}`)) return null;
      return get(`${API}/messages/${id}?format=full`) as Promise<GmailMessage>;
    }));
    for (const m of msgs) {
      done++;
      if (!m) { duplicates++; continue; }
      const e = parseCardAlert(toEmailLite(m));
      if (e) added.push(e); else skipped++;
    }
    opts.onProgress?.(done, todo.length);
  }
  return { scanned: todo.length, added, skipped, duplicates };
}
