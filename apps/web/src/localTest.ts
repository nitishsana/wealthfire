// Local test mode for the `localkyc` build (rules in @wealthfire/core localTest.ts). Read once at page load:
// - ?persona=<id>: this tab is that test user (kept in sessionStorage, so reloads and partner returns keep it);
//   every browser storage key gets the `wf.persona.<id>.` prefix so test users never mix.
// - ?server=off: no KYC server (demo mode).
// Any other build (VITE_API_URL not a loopback address, e.g. the live site): both are ignored.
import { personaPrefill, personaStorageKey, PERSONA_SESSION_KEY, resolveLocalTestMode, type PersonaPrefill } from '@wealthfire/core';

function readStored(): string | null {
  try { return window.sessionStorage.getItem(PERSONA_SESSION_KEY); } catch { return null; }
}

const mode = resolveLocalTestMode({ apiUrl: import.meta.env.VITE_API_URL, search: window.location.search, storedPersona: readStored() });
try {
  if (mode.store === null) window.sessionStorage.removeItem(PERSONA_SESSION_KEY);
  else if (mode.store !== undefined) window.sessionStorage.setItem(PERSONA_SESSION_KEY, mode.store);
} catch { /* storage blocked: the persona lasts for this page load only */ }

/** The test user for this tab, or null. */
export const testPersona = mode.persona;
/** ?server=off in the localkyc build: run without the KYC server. */
export const serverOff = mode.serverOff;
/** Form prefill for the test user, or null. */
export const personaFill: PersonaPrefill | null = testPersona ? personaPrefill(testPersona) : null;

/** The browser storage key to use for `key` in this tab. */
export function storageKey(key: string): string {
  return personaStorageKey(testPersona, key);
}
