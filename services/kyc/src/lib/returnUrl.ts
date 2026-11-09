// DigiLocker / e-sign return-URL allow-list (R10, S15). One parser and one matcher shared by the
// KYC service and the Lambda adapter. Matching compares the parsed URL origin and the normalised
// pathname against each entry, never a raw string prefix, so `.../wealthfire/../other/` or a
// look-alike host cannot pass. The app deep link is pinned to one exact URL.
import { listEnv, ENV, type Env } from './env';

/** The phone apps' DigiLocker / e-sign return deep link (matched exactly). */
export const APP_RETURN_URL = 'wealthfire://kyc-return';

/**
 * Built-in default (used only when RETURN_URL_PREFIXES is unset). No loopback entry: the dev
 * stack adds the local preview through RETURN_URL_PREFIXES.
 */
export const DEFAULT_RETURN_URL_PREFIXES: readonly string[] = Object.freeze([
  'https://nitishsana.github.io/wealthfire/',
  APP_RETURN_URL,
]);

export const MAX_RETURN_URL_LENGTH = 500;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
// Older stacks set the bare scheme; it now means the one pinned deep link, never the whole scheme.
const LEGACY_APP_SCHEME = 'wealthfire://';

function isWebUrl(p: string): boolean {
  return p.startsWith('https://') || p.startsWith('http://');
}

/**
 * Validates allow-list entries. Each is the exact app deep link, or an https (or local http)
 * URL with no credentials, query or fragment, whose path ends in '/' and is already normalised.
 * Throws an error naming RETURN_URL_PREFIXES (never the value).
 */
export function parseReturnUrlPrefixes(entries: readonly string[]): string[] {
  const bad = (): never => {
    throw new Error(`Bad ${ENV.returnUrlPrefixes} entry`);
  };
  const out: string[] = [];
  for (const raw of entries) {
    const p = raw.trim();
    if (p === APP_RETURN_URL || p === LEGACY_APP_SCHEME) {
      if (!out.includes(APP_RETURN_URL)) out.push(APP_RETURN_URL);
      continue;
    }
    if (!isWebUrl(p)) bad();
    let u: URL;
    try {
      u = new URL(p);
    } catch {
      return bad();
    }
    const httpOk = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && u.port !== '');
    if (!httpOk || u.username || u.password || u.search || u.hash || !u.pathname.endsWith('/') || u.href !== p) bad();
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** RETURN_URL_PREFIXES (validated), else the built-in default. */
export function returnUrlPrefixesFromEnv(env: Env): string[] {
  const list = listEnv(env, ENV.returnUrlPrefixes);
  return list.length === 0 ? [...DEFAULT_RETURN_URL_PREFIXES] : parseReturnUrlPrefixes(list);
}

/**
 * The normalised return URL when it is allowed, else null. Web URLs must share an entry's origin
 * and start with its (normalised) path; encoded slashes / backslashes / dots in the path are
 * refused. The app deep link must equal the pinned URL exactly.
 */
export function allowedReturnUrl(value: unknown, prefixes: readonly string[] = DEFAULT_RETURN_URL_PREFIXES): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RETURN_URL_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (!isWebUrl(value)) return prefixes.includes(value) ? value : null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  if (/%(2f|5c|2e)/i.test(u.pathname)) return null;
  for (const p of prefixes) {
    if (!isWebUrl(p)) continue;
    let base: URL;
    try {
      base = new URL(p);
    } catch {
      continue;
    }
    if (u.origin === base.origin && u.pathname.startsWith(base.pathname)) return u.href;
  }
  return null;
}
