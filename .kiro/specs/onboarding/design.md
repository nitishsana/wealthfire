# Design: Onboarding journey

Repo: `C:\Users\sananiti\.kiro\crew\workspace\wealthfire` (clone of `github.com/nitishsana/wealthfire`), branch `feature/onboarding` from `origin/main` @ `17aa781`.
Implements every requirement in `requirements.md`. Modelled on the Gmail feature: pure logic in `packages/core`, thin screens on web and mobile, feature ids checked by `scripts/check-parity.mjs`.

## 1. Overview

```
App start
  └─ data.onboarding.step !== 'done' ?
        yes → <Onboarding> (full screen, no nav)       no → normal app shell
                 signin → otp → identity → aadhaar-otp → done ("You're all set")
                    │       │                    │
                    └───────┴──── OtpProvider ───┘   (v1: DemoOtpProvider; later DigiLocker / Digio)
```

- `packages/core/src/onboarding.ts`: validators, masking, Verhoeff, the step reducer and the OTP rules (expiry, tries, resend, lockout). Pure functions; time is passed in.
- `packages/core/src/otp.ts`: the `OtpProvider` interface (the plug-in slot) and `DemoOtpProvider`.
- Web: `apps/web/src/pages/Onboarding.tsx`, `apps/web/src/components/OtpStep.tsx`, `apps/web/src/otp.ts`.
- Mobile: `packages/mobile-ui/src/screens/Onboarding.tsx` (Android + iOS share it).
- Gate: `apps/web/src/App.tsx` and `Body` in `packages/mobile-ui/src/index.tsx`.

## 2. Data model (`packages/core/src/types.ts`)

```ts
export type OnboardingStep = 'signin' | 'otp' | 'identity' | 'aadhaar-otp' | 'done';
export type ContactKind = 'email' | 'mobile';
export type OtpProviderId = 'demo' | 'digilocker' | 'digio';

export interface OnboardingState {
  step: OnboardingStep;
  contact: { kind: ContactKind; value: string; verifiedAt: string | null } | null; // value: lower-cased email or 10 digits
  identity: { firstName: string; lastName: string; pan: string } | null;
  /** Only the last 4 digits are ever stored. */
  aadhaar: { last4: string; verifiedAt: string; provider: OtpProviderId } | null;
  completedAt: string | null;
  /** Send times (ISO) per channel in the last 10 minutes, for the resend limit. */
  sends: { contact: string[]; aadhaar: string[] };
  /** Aadhaar step lockout (Req 4.9). Persisted so a restart does not bypass it. */
  aadhaarLockedUntil: string | null;
}

export interface AppData {
  // ...existing fields unchanged
  onboarding: OnboardingState;
}
```

Not stored anywhere: OTP codes, OTP request ids, the full Aadhaar number, the consent tick. They live in React component state only (Req 5.2, 5.3).

`store.ts` changes:
- `emptyOnboarding()` returns `{ step: 'signin', contact: null, identity: null, aadhaar: null, completedAt: null, sends: { contact: [], aadhaar: [] }, aadhaarLockedUntil: null }`.
- `emptyData()` adds `onboarding: emptyOnboarding()`.
- `deserialize()` adds `onboarding: sanitizeOnboarding(raw.onboarding)`. Old data with no field gets `emptyOnboarding()` (Req 5.4). `sanitizeOnboarding` keeps only known keys, forces `aadhaar.last4` to `/^\d{4}$/` or drops it, and drops `step: 'done'` if `aadhaar` is missing (so a hand-edited file cannot skip Aadhaar OTP, Req 4.6).
- `demoData()` (demo.ts) also gets `onboarding: emptyOnboarding()`; the Settings "Load demo data" buttons keep the current onboarding: `replace({ ...demoData(), onboarding: data.onboarding })`.
- "Delete all data" keeps calling `replace(emptyData())`, which resets onboarding and shows sign-in (Req 5.5).

## 3. OTP provider slot (`packages/core/src/otp.ts`)

```ts
export type OtpChannel = 'email' | 'sms' | 'aadhaar';

export interface OtpSendRequest {
  channel: OtpChannel;
  /** email address, 10-digit mobile, or full 12-digit Aadhaar (aadhaar channel; never stored by the app) */
  target: string;
}

export type OtpSendResult =
  | { ok: true; requestId: string; expiresAt: number; demoCode?: string }
  | { ok: false; reason: 'no-linked-mobile' | 'invalid-target' | 'rate-limited' | 'network'; message: string };

export type OtpVerifyResult =
  | { ok: true; aadhaarLast4?: string }
  | { ok: false; reason: 'wrong' | 'expired' | 'void' | 'network'; message: string };

export interface OtpProvider {
  id: OtpProviderId;
  /** true → screens show the "Demo code" banner */
  isDemo: boolean;
  send(req: OtpSendRequest, now: number): Promise<OtpSendResult>;
  verify(requestId: string, code: string, now: number): Promise<OtpVerifyResult>;
}
```

### DemoOtpProvider

- `new DemoOtpProvider(random = defaultRandom)`. `defaultRandom` uses `globalThis.crypto.getRandomValues` when present, else `Math.random` (Hermes fallback; acceptable because codes are shown on screen anyway).
- `send` makes a 6-digit code (`000000`–`999999`, zero-padded), a request id, `expiresAt = now + 5 min`, and keeps `{ code, expiresAt, tries: 0 }` in a private `Map`. A new send for the same `channel + target` deletes the older entry (Req 2.8). Returns `demoCode`.
- Aadhaar channel: any target ending in `0000` returns `no-linked-mobile`, so the error path can be demoed and tested (Req 4.8). Returns `aadhaarLast4` on verify.
- `verify`: missing id → `void`; `now > expiresAt` → `expired`; wrong code → `tries++`, `wrong`; on 5th wrong try the entry is deleted → `void`; right code → entry deleted, `ok`.
- In-memory only, so a restart voids every code (Req 5.2).

### Plugging in DigiLocker or Digio later

Both need a licensed partner account and a server that holds the API secret; the phone or browser must never hold it. The later work is:
1. A small backend with two routes, `POST /otp/send` and `POST /otp/verify`, that call the partner (DigiLocker OAuth + Aadhaar e-KYC, or Digio KYC/eSign APIs).
2. A `HttpOtpProvider` in `packages/core/src/otp.ts` (`id: 'digilocker' | 'digio'`, `isDemo: false`) that calls those routes. It returns only `aadhaarLast4`, never the full number or XML.
3. Set the provider id in config: web `VITE_OTP_PROVIDER` + `VITE_OTP_API_URL`; phones `expo.extra.otpProvider` + `expo.extra.otpApiUrl`.

`createOtpProvider(cfg: { provider?: string; apiUrl?: string })` is the single factory. In v1 it returns `DemoOtpProvider` for `undefined` or `'demo'`, and throws `Error('OTP provider "<id>" is not built yet')` for anything else, so a misconfiguration is loud. No screen changes when a real provider lands.

## 4. Core logic (`packages/core/src/onboarding.ts`)

### Validators (each returns `string | null`: error text or OK)

| Function | Rule | Error text |
|---|---|---|
| `normalizeEmail(s)` | trim + lower-case | — |
| `validateEmail(s)` | `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`, ≤ 254 chars | "Enter a valid email address." |
| `normalizeMobile(s)` | strip spaces, dashes, leading `+91`/`0` | — |
| `validateMobile(s)` | `^[6-9]\d{9}$` after normalize | "Enter a valid 10-digit mobile number." |
| `validateName(s)` | trim, `^[\p{L}][\p{L} .'-]{0,49}$`u | "Use 1–50 letters." |
| `normalizePan(s)` | trim + upper-case | — |
| `validatePan(s)` | `^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$`; 4th char ≠ `P` → | "Enter a valid PAN, like ABCPE1234F." / "This looks like a non-individual PAN. Use your personal PAN." |
| `panSurnameWarning(pan, last)` | 5th char ≠ first letter of last name | "PAN's 5th letter usually matches your last name" (soft) |
| `normalizeAadhaar(s)` | keep digits only | — |
| `validateAadhaar(s)` | 12 digits, first 2–9, `verhoeffValid` | "Enter a valid 12-digit Aadhaar number." |
| `verhoeffValid(digits)` | standard Verhoeff d/p/inv tables | — |

### Display helpers

`maskEmail('nitish@gmail.com') → 'n*****@gmail.com'`, `maskMobile('9876543210') → '+91 ******3210'`, `maskPan('ABCPE1234F') → 'ABCPE****F'`, `maskAadhaar('1234') → 'XXXX XXXX 1234'`, `groupAadhaar('234123412346') → '2341 2341 2346'`.

### OTP rules (shared by contact and Aadhaar steps)

```ts
export const OTP_RULES = { length: 6, expiryMs: 5 * 60_000, maxTries: 5, resendCooldownMs: 30_000,
  maxSendsPerWindow: 4 /* 1 send + 3 resends */, windowMs: 10 * 60_000, aadhaarLockMs: 30 * 60_000 } as const;

canSend(sends: string[], now: number, lockedUntil?: string | null):
  { ok: true } | { ok: false; waitMs: number; reason: 'cooldown' | 'limit' | 'locked' }
pruneSends(sends: string[], now: number): string[]   // keep only last 10 minutes
```

- `cooldown`: last send < 30 s ago → UI shows "Resend in 0:SS".
- `limit`: 4 sends in the 10-minute window → "Too many tries. Try again in M minutes." On the Aadhaar step this also sets `aadhaarLockedUntil = now + 30 min` (Req 4.9).
- `locked`: `now < aadhaarLockedUntil` → "Too many tries. Try again in M minutes."; nothing else in the app opens because `step` is still not `done`.

### Step reducer

```ts
type OnboardingEvent =
  | { type: 'otp-sent'; channel: 'contact' | 'aadhaar'; at: string; contact?: { kind: ContactKind; value: string } }
  | { type: 'contact-verified'; at: string }
  | { type: 'change-contact' }
  | { type: 'identity-saved'; firstName: string; lastName: string; pan: string }
  | { type: 'back-to-identity' }
  | { type: 'aadhaar-verified'; last4: string; at: string; provider: OtpProviderId }
  | { type: 'aadhaar-locked'; until: string }
  | { type: 'sign-out' };

export function onboardingReducer(s: OnboardingState, e: OnboardingEvent): OnboardingState
```

| Event | From step | Result |
|---|---|---|
| `otp-sent` (contact) | `signin`/`otp` | `step: 'otp'`, `contact` set (unverified), send time appended |
| `contact-verified` | `otp` | `contact.verifiedAt` set, `step: 'identity'` |
| `change-contact` | `otp` | `step: 'signin'`, `contact: null` |
| `identity-saved` | `identity` | trimmed + normalized identity, `step: 'aadhaar-otp'`; ignored if any validator fails |
| `back-to-identity` | `aadhaar-otp` | `step: 'identity'` (identity kept) |
| `aadhaar-verified` | `aadhaar-otp` | requires `/^\d{4}$/`; `aadhaar` set, `step: 'done'`, `completedAt` |
| `aadhaar-locked` | `aadhaar-otp` | `aadhaarLockedUntil` set |
| `sign-out` | any | `emptyOnboarding()` (financial data untouched, Req 5.6) |

Any event from a wrong step returns the state unchanged. `step: 'done'` is reachable only through `aadhaar-verified` (Req 4.6).

`resumeStep(s)` returns `s.step` (the store already holds the first step not done). On `otp`/`aadhaar-otp` the screen opens with no active code and a "Send OTP" button (Req 5.2).

`prefillProfileName(data)`: if `profile` is null or `profile.name` is empty and `identity` exists, return `First Last`. Used by Profile pages on web and mobile (Req 3.9).

## 5. Screens

Same text on web and mobile (Req 6.3). Every screen shows the brand header and the not-advice disclaimer, and no nav (Req 6.7).

| Step | Feature id | Fields / controls | Primary button |
|---|---|---|---|
| Sign in | `onboard-signin` | Segmented "Mobile number" (default) / "Email"; `+91` prefix; input | "Send OTP" (disabled until valid) |
| Contact OTP | `onboard-otp` | "We sent a code to {masked}" + "Change"; 6-digit field; demo banner; "Resend in 0:SS" / "Resend OTP" | "Verify" |
| Your details | `onboard-identity` | First name, Last name, PAN, Aadhaar (grouped, masked, Show/Hide), consent checkbox | "Continue" |
| Aadhaar OTP | `onboard-aadhaar-otp` | "Enter the OTP sent to the mobile linked with Aadhaar XXXX XXXX 1234."; 6-digit field; demo banner; resend; "Back" | "Verify Aadhaar" |
| Done | (inside `onboard-aadhaar-otp`) | "You're all set, {First}." | "Go to Home" |
| Settings → Account | `onboard-account` | Contact (masked), PAN (masked), Aadhaar `XXXX XXXX 1234` with "Verified" | "Sign out" |

Demo banner text: "Demo mode: no real SMS or email is sent. Your code is 123456." On the Aadhaar step: "Demo mode: no real Aadhaar OTP is sent. Your code is 123456. In the live app this comes from UIDAI to your Aadhaar-linked mobile." Shown only when `provider.isDemo`.

### Shared OTP step component

Web `apps/web/src/components/OtpStep.tsx` and a local `OtpStep` inside `packages/mobile-ui/src/screens/Onboarding.tsx` share one contract: props `{ provider, channel, target, sends, lockedUntil, onSent(at), onVerified(result), onLocked(until) }`. Inside: `requestId`, `demoCode`, `code`, `error`, a 1-second ticker for the countdown (cleared on unmount), and the call to `canSend` before every send.

### Field details

- Web: `<input inputMode="numeric" autoComplete="one-time-code" maxLength={6}>` for OTP; `type="email" autoComplete="email"`; `type="tel" autoComplete="tel-national"`; Aadhaar `inputMode="numeric" autoComplete="off"` with `type="password"` when hidden. Errors use `aria-describedby` + `aria-invalid`, status lines `role="status"`.
- Mobile: OTP `keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp"`; email `keyboardType="email-address" autoCapitalize="none"`; mobile `keyboardType="phone-pad"`; Aadhaar `keyboardType="number-pad" secureTextEntry={hidden}`; each input has `accessibilityLabel` and its error `accessibilityLiveRegion="polite"`.
- Errors show after blur (Req 1.5); the PAN surname note is styled as `warn`, not `bad`.

## 6. Gate and wiring

- Web `App.tsx`: `const { data } = useStore(); if (data.onboarding.step !== 'done') return <OnboardingPage />;` before the shell. Router paths are left alone, so finishing onboarding lands on whatever path was opened (Home by default; "Go to Home" calls `navigate('/')`).
- Web `apps/web/src/otp.ts`: `export const otpProvider = createOtpProvider({ provider: import.meta.env.VITE_OTP_PROVIDER, apiUrl: import.meta.env.VITE_OTP_API_URL })` — one instance for the page's life.
- Mobile `index.tsx`: new prop `otp?: { provider?: string; apiUrl?: string }` on `WealthfireApp`, passed from `apps/android/App.tsx` and `apps/ios/App.tsx` via `Constants.expoConfig.extra` (same pattern as `google`). `Body` renders `<OnboardingScreen />` instead of the tab bar + screen when `loaded && data.onboarding.step !== 'done'`, then `setTab('home')` on finish.
- Settings: web `Settings.tsx` and mobile `SettingsScreen` get an "Account" card tagged `onboard-account`; "Load demo data" keeps onboarding.
- Profile: web `Profile.tsx` and mobile `ProfileScreen` use `prefillProfileName` as the name's initial value.
- `features.ts`: add the five ids under the existing list with names starting "Onboarding: …".

## 7. Security and privacy

- Full Aadhaar: component state only; cleared on verify, on Back and on unmount. Never in `AppData`, so never in localStorage/AsyncStorage or the backup file.
- OTP codes and request ids: never stored, never logged; no `console.log` in onboarding files.
- PAN is stored in full (needed later for KYC/CAS) and only shown masked outside the details screen.
- The demo provider is clearly labelled everywhere it is used; `isDemo` cannot be hidden by config.
- Lockout and send history are stored, so reloading cannot reset the limits. On web this is client-side only; a real provider must enforce the same limits server-side.

## 8. Testing

Vitest, in `packages/core/test/onboarding.test.ts` and `packages/core/test/otp.test.ts`:

| Area | Cases |
|---|---|
| Email / mobile | valid, upper-case + spaces normalized, `+91`/dash stripped, starts with 5 rejected, 9 or 11 digits rejected |
| Names | Unicode letters, apostrophe/hyphen ok, empty, 51 chars, digits rejected |
| PAN | valid individual, lower-case normalized, company `C` → non-individual message, bad shape, surname warning on/off |
| Aadhaar | Verhoeff pass (`234123412346`), one digit changed fails, first digit 0/1 fails, 11 digits fails, grouping + masking |
| OTP rules | cooldown at 29 s vs 30 s, 4th send ok and 5th blocked in 10 min, window slides, lock until 30 min |
| Demo provider | 6-digit code, expiry at 5 min + 1 ms, 5 wrong → void, new send voids old, `…0000` → no-linked-mobile, returns `aadhaarLast4` |
| Reducer | happy path signin → done, wrong-step events ignored, `done` only via `aadhaar-verified`, sign-out resets onboarding only |
| Store | old JSON without `onboarding` loads with `step: 'signin'` and keeps assets; hand-edited `done` without `aadhaar` resets; serialized data never contains a 12-digit run |
| Factory | `undefined`/`'demo'` → demo; `'digio'` throws "not built yet" |

Then run `npm test`, `npm run typecheck`, `npm run parity`, `npm run build`, and both Expo exports. Last, a local preview at `http://127.0.0.1:5180` for Nitish to click through before any push.

## 9. Feature log

On merge, add to `FEATURES.md` a new `## Onboarding` section (after Platform) with five rows: sign in with mobile or email, contact OTP, profile identity details (name, PAN, Aadhaar with checks), mandatory Aadhaar OTP (demo provider, DigiLocker/Digio slot), Settings Account card with sign out. Each row ends `(PR #n)`.
