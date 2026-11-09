// Local test mode switches for the web app's `localkyc` build (.kiro/specs/final-kyc-service/local-mode.md,
// "Local test home"). Pure functions; apps/web/src/localTest.ts only reads the URL and sessionStorage.
//   ?persona=<id>  sign in as one of LOCAL_PERSONAS: own storage space, prefilled mobile, DEMO code and
//                  Your details, and a 'Test user: <name> · Switch user' bar back to the Local test home.
//   ?server=off    run the app with no KYC server (demo mode) for the demo-mode test cases.
// Both work only when the app's API URL is a loopback address (the localkyc build); otherwise ignored.
import { localPersona, type LocalPersona } from './localPersonas';
import { normalizeDob, verhoeffValid } from './onboarding';

export const PERSONA_PARAM = 'persona';
export const SERVER_PARAM = 'server';
export const SERVER_OFF_VALUE = 'off';
/** sessionStorage key (per tab) that keeps the chosen persona across reloads and partner returns. */
export const PERSONA_SESSION_KEY = 'wf.persona';
/** The Local test home page on the local KYC server. */
export const LOCAL_HOME_URL = 'http://127.0.0.1:5181/';
export const SWITCH_USER_TEXT = 'Switch user';

/** True when `apiUrl` is an http(s) URL on 127.0.0.1 or localhost (the localkyc build). */
export function isLocalApiUrl(apiUrl: string | null | undefined): boolean {
  const raw = apiUrl?.trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

export interface LocalTestMode {
  /** the test user for this tab, or null (normal app) */
  persona: LocalPersona | null;
  /** ?server=off: no KYC server, demo mode */
  serverOff: boolean;
  /** what to keep in sessionStorage under PERSONA_SESSION_KEY: an id, null to remove, undefined to leave as is */
  store: string | null | undefined;
}

const OFF: LocalTestMode = { persona: null, serverOff: false, store: undefined };

/**
 * Local test mode from the build's API URL, the page's query string and the persona id kept for this
 * tab. A known `?persona=` wins and is kept for the tab; an unknown one is ignored (the kept one, if
 * any, stays). Non-local builds: always off.
 */
export function resolveLocalTestMode(o: { apiUrl: string | null | undefined; search: string; storedPersona: string | null }): LocalTestMode {
  if (!isLocalApiUrl(o.apiUrl)) return OFF;
  const q = new URLSearchParams(o.search);
  const serverOff = q.get(SERVER_PARAM) === SERVER_OFF_VALUE;
  const fromUrl = localPersona(q.get(PERSONA_PARAM));
  if (fromUrl) return { persona: fromUrl, serverOff, store: fromUrl.id };
  const kept = localPersona(o.storedPersona);
  // a kept id that is no longer in the list is removed
  return { persona: kept ?? null, serverOff, store: kept || o.storedPersona === null ? undefined : null };
}

/** The browser storage key for `key`: `wf.persona.<id>.<key>` for a test user, else `key` unchanged. */
export function personaStorageKey(persona: Pick<LocalPersona, 'id'> | null, key: string): string {
  return persona ? `wf.persona.${persona.id}.${key}` : key;
}

/** 'Test user: <name>' for the bar above the app. */
export function personaBarText(persona: Pick<LocalPersona, 'name'>): string {
  return `Test user: ${persona.name}`;
}

/**
 * A made-up 12-digit Aadhaar that passes the app's check and ends in `last4` (the local DigiLocker page
 * asks for the same last 4). Test data only: never a real number in use.
 */
export function testAadhaarFor(last4: string): string {
  if (!/^\d{4}$/.test(last4)) return '';
  for (let a = 0; a < 100; a++) {
    for (let d = 0; d < 10; d++) {
      const n = `2${String(a).padStart(2, '0')}9999${d}${last4}`; // 12 digits, starts with 2 (a valid first digit)
      if (verhoeffValid(n)) return n;
    }
  }
  return '';
}

export interface PersonaPrefill {
  mobile: string;
  identity: { firstName: string; lastName: string; pan: string; dob: string };
  /** full 12-digit test Aadhaar ending in the persona's last 4 (component state only) */
  aadhaar: string;
}

/** What the sign-in and Your details forms start with for this test user. `identity.dob` is YYYY-MM-DD. */
export function personaPrefill(p: LocalPersona): PersonaPrefill {
  return {
    mobile: p.mobile,
    identity: { firstName: p.firstName, lastName: p.lastName, pan: p.pan, dob: normalizeDob(p.dob) },
    aadhaar: testAadhaarFor(p.aadhaarLast4),
  };
}
