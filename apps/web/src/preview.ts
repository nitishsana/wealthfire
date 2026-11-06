// Local preview switch, used by the launchers in "CMD files/".
// Opening the Vite dev server with ?preview=demo in an EMPTY browser (the launchers use an
// Edge InPrivate window) loads the demo user with onboarding already finished, so a single
// section can be checked without signing in first.
// Safety: import.meta.env.DEV is false in `npm run build`, so this never runs on the live site,
// and it never replaces data that is already stored in the browser.
import { demoData, STORAGE_KEY, type AppData } from '@wealthfire/core';

export const PREVIEW_PARAM = 'preview';
export const PREVIEW_VALUE = 'demo';

export function previewData(): AppData | null {
  if (!import.meta.env.DEV) return null;
  if (new URLSearchParams(window.location.search).get(PREVIEW_PARAM) !== PREVIEW_VALUE) return null;
  if (localStorage.getItem(STORAGE_KEY)) return null; // never overwrite real data

  const now = new Date().toISOString();
  const d = demoData();
  d.onboarding = {
    ...d.onboarding,
    step: 'done',
    contact: { kind: 'mobile', value: '9876543210', verifiedAt: now },
    identity: { firstName: 'Demo', lastName: 'User', pan: 'ABCPU1234F' },
    aadhaar: { last4: '2346', verifiedAt: now, provider: 'demo' },
    completedAt: now,
  };
  return d;
}
