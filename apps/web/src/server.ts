// Final KYC server (services/kyc) for the web app. Only active when VITE_API_URL is set at build time.
// Without it (the live site today, plain `vite`) `kycServer` is null and every screen keeps its
// device-only behaviour (demo OTP, device status). The preview launcher runs `vite --mode localkyc`,
// which sets it to the local KYC server on http://127.0.0.1:5181 (apps/web/.env.localkyc).
//
// Tokens: the access token stays in memory only (lost on reload). The refresh token is an HttpOnly
// cookie on the API domain; ServerKycClient sends `credentials: 'include'` on /auth/* so
// POST {API}/auth/refresh issues a new access token after a reload.
import { ServerKycClient, type TokenStore } from '@wealthfire/core';
import { serverOff, testPersona } from './localTest';

/** '' counts as unset: CI turns a missing repo variable into an empty string. */
function apiBase(): string | null {
  // ?server=off (localkyc build only): demo mode, no server
  if (serverOff) return null;
  const raw = import.meta.env.VITE_API_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // HTTPS only; plain http is allowed for a loopback dev API.
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Access token in memory only. */
function memoryTokens(): TokenStore {
  let access: string | null = null;
  return {
    get: async () => access,
    set: async (t) => { access = t; },
  };
}

export const API_URL = apiBase();

/** The one server client for the page's life, or null without VITE_API_URL. */
export const kycServer: ServerKycClient | null = API_URL
  ? new ServerKycClient({ baseUrl: API_URL, fetch: (url, init) => window.fetch(url, init), tokens: memoryTokens(), client: 'web', persona: testPersona?.id ?? null })
  : null;

/** Query flag the partner pages (DigiLocker, e-sign) send the user back with. */
export const KYC_RETURN_PARAM = 'kyc';
export const KYC_RETURN_VALUE = 'return';

/** Where DigiLocker / e-sign send the user back: this page with ?kyc=return, on Settings. */
export function kycReturnUrl(): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}?${KYC_RETURN_PARAM}=${KYC_RETURN_VALUE}#/settings`;
}

/** True once when the page was opened by a partner redirect back to the app. */
export function isKycReturn(): boolean {
  return new URLSearchParams(window.location.search).get(KYC_RETURN_PARAM) === KYC_RETURN_VALUE;
}

/** Removes ?kyc=return from the address bar (keeps the hash route). */
export function clearKycReturn() {
  const u = new URL(window.location.href);
  u.searchParams.delete(KYC_RETURN_PARAM);
  window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
}

/**
 * Partner pages the app may send the user to. Only HTTPS origins listed in
 * VITE_KYC_REDIRECT_ORIGINS (comma separated) are allowed; the API origin itself is always allowed
 * (the FakePartner pages of the dev stack live there).
 */
const REDIRECT_ORIGINS: ReadonlySet<string> = new Set(
  [API_URL ? new URL(API_URL).origin : '', ...(import.meta.env.VITE_KYC_REDIRECT_ORIGINS ?? '').split(',')]
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => { try { return [new URL(s).origin]; } catch { return []; } }),
);

/** The URL if it is safe to open (HTTPS + allow-listed origin), else null. */
export function safeRedirect(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
    const httpsOrLoopback = u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
    if (!httpsOrLoopback || !REDIRECT_ORIGINS.has(u.origin)) return null;
    return u.href;
  } catch {
    return null;
  }
}
