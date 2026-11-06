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


---

# Part B — Documents, number check and manual review (Requirements 7–9)

Change request of 2026-11-06. Decisions taken by Nitish: demo document reader with a partner slot; demo reviewer panel; documents in memory only; numbers are still typed in "Your details" and the documents check them; Google Drive on desktop through Google's own picker.

## B1. Flow and steps

```
signin → otp → identity → documents → check → aadhaar-otp → done
                              │           │            │
                       DocumentReader (v1: DemoDocumentReader; later Digio / HyperVerge OCR)
```

- `OnboardingStep` becomes `'signin' | 'otp' | 'identity' | 'documents' | 'check' | 'aadhaar-otp' | 'done'`.
- `identity-saved` now goes to `documents` (not `aadhaar-otp`). The first Aadhaar OTP is sent when the user taps Confirm on Check numbers, for the **final** Aadhaar number.
- Reload on `documents`, `check` or `aadhaar-otp`: the full Aadhaar and the documents are gone (memory only), so the screen dispatches `back-to-identity` (name and PAN kept). Locks and send history still apply.

## B2. Data model additions (`packages/core/src/types.ts`)

```ts
export type KycField = 'pan' | 'aadhaar';
export type KycMatch = 'matched' | 'review';
export type KycStatus = 'verified' | 'under-review' | 'rejected';
export type DocReaderId = 'demo' | 'digio' | 'hyperverge';

export interface ReviewRecord {
  id: string;                    // 'rv_' + time in base 36 (no long digit runs in storage)
  sentAt: string;                // ISO, set when the Aadhaar OTP passes
  fields: { field: KycField; typedMasked: string; readMasked: string }[]; // masks only, never full Aadhaar
  decision: { result: 'approved' | 'rejected'; reason: string | null; at: string } | null;
}

export interface KycState {
  match: KycMatch | null;        // set on Check numbers → Confirm
  status: KycStatus | null;      // set when the Aadhaar OTP passes; changed by a review decision
  reader: DocReaderId | null;
  rereads: { pan: number; aadhaar: number }; // max 2 each (Req 8.8)
  review: ReviewRecord | null;
  documentsAt: string | null;    // time all 3 documents were added (the files themselves are never stored)
}

export interface OnboardingState { /* ...Part A fields... */ kyc: KycState }
```

`emptyKyc()` = `{ match: null, status: null, reader: null, rereads: { pan: 0, aadhaar: 0 }, review: null, documentsAt: null }`.

`sanitizeOnboarding` additions: unknown `kyc` → `emptyKyc()`; masks must match `/^[A-Z0-9X* ]{4,14}$/`; rereads clamped to 0–2; `step: 'done'` with `kyc.status === null` is lowered to `identity` (only local previews made before this change are affected).

## B3. Document reader slot (`packages/core/src/docreader.ts`)

```ts
export type DocKind = 'selfie' | 'aadhaar' | 'pan';
export type DocMime = 'image/jpeg' | 'image/png' | 'application/pdf';

export interface DocFile {
  kind: DocKind;
  name: string;
  mime: DocMime;
  size: number;                  // bytes
  /** Opaque handle the app can read: blob: URL on web, file:// cache URI on phones. Never stored. */
  uri: string;
}

export interface ReadOptions {
  strict: boolean;               // true on a re-read (Req 8.6)
  /** Demo reader only: the number to compare against. A real reader must never trust it. */
  expected?: string;
}

export type ReadResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'unreadable' | 'invalid' | 'network'; message: string };

export interface DocumentReader {
  id: DocReaderId;
  isDemo: boolean;
  read(doc: DocFile, field: KycField, opts: ReadOptions): Promise<ReadResult>;
}

export type DemoReadMode = 'match' | 'misread' | 'different' | 'unreadable';
export class DemoDocumentReader implements DocumentReader { constructor(public mode: DemoReadMode = 'match') {} }
export function createDocumentReader(cfg: { reader?: string; apiUrl?: string }): DocumentReader;
export function validateDocFile(f: Pick<DocFile, 'kind' | 'mime' | 'size'>): string | null;
```

`validateDocFile`: selfie accepts `image/jpeg`/`image/png`; Aadhaar and PAN also `application/pdf`; max 10 MB. Error text: selfie "Use a JPG or PNG photo under 10 MB.", cards "Use a JPG, PNG or PDF under 10 MB." (Req 7.5).

### Demo reader modes (developer setting only, never shown to users; see "Where the mode is set")

| Mode | First read | Strict re-read | Shows scenario |
|---|---|---|---|
| `match` (default) | returns `expected` | returns `expected` | 1 |
| `misread` | `expected` with one character changed, still a valid PAN / Verhoeff-valid Aadhaar | returns the original `expected` (the typed number) | 2 |
| `different` | a fixed other valid number (`AAAPZ9999Z`, `499118665246`; swaps to `234123412346` if typed equals it) | same as first read | 3 |
| `unreadable` | `{ ok: false, reason: 'unreadable' }` | same | Req 8.2 |

Helper `verhoeffCheckDigit(first11)` is added to `onboarding.ts` so `misread` can produce a valid Aadhaar.

**Where the mode is set (changed 2026-11-06 by Nitish: no demo UI on Upload documents).** Users never see the mode or any "Demo mode" text on this step. Default is `match`. Developers switch it only in local builds: web reads `?reader=match|misread|different|unreadable` when `import.meta.env.DEV` is true (ignored on the live site); phones read `appJson.expo.extra.demoReaderMode` only when `__DEV__` is true. Scenario launchers in `CMD files/` pass the web parameter.

`createDocumentReader` mirrors `createOtpProvider`: `undefined`/`''`/`'demo'` → demo; anything else throws `Document reader "<id>" is not built yet`. A real partner reader later is an `HttpDocumentReader` calling a small backend (`POST /kyc/read`) that uploads the file to the partner over HTTPS and returns only the number; config `VITE_DOC_READER` + `VITE_DOC_READER_URL` on web, `expo.extra.docReader` + `docReaderUrl` on phones.

## B4. Check logic (`packages/core/src/kyc.ts`)

```ts
export const MAX_REREADS = 2;
export interface FieldCheck { field: KycField; typed: string; read: string; final: string; matched: boolean; rereads: number; source: 'typed' | 'document' | 'edited' }
export function compareField(field: KycField, typed: string, read: string): boolean; // normalize then ===
export function initialChecks(typed: { pan: string; aadhaar: string }, read: { pan: string; aadhaar: string }): FieldCheck[];
export function takeDocumentNumber(c: FieldCheck): FieldCheck;            // final = read, matched = true, source 'document'
export function applyReread(c: FieldCheck, final: string, reread: string): FieldCheck; // rereads+1, matched = compareField(final, reread)
export function canReread(c: FieldCheck): boolean;                       // rereads < MAX_REREADS
export function checkOutcome(cs: FieldCheck[]): { match: KycMatch; differs: KycField[] };
export function reviewFields(cs: FieldCheck[]): ReviewRecord['fields'];  // masks: maskPan, maskAadhaar(last4)
export function isEligibleToInvest(data: AppData): boolean;              // step done && kyc.status === 'verified'
export function kycStatusLabel(s: KycStatus | null): string;             // 'Verified' | 'Under review' | 'Review rejected' | 'Not started'
```

`FieldCheck` objects live in screen state only (they hold the full Aadhaar). Only `checkOutcome`, the final PAN, the Aadhaar last 4 and `reviewFields` reach the store.

### New reducer events (`onboardingReducer`)

| Event | From | Result |
|---|---|---|
| `identity-saved` | `identity` | → `documents` (changed) |
| `documents-ready { at, reader }` | `documents` | `kyc.documentsAt`, `kyc.reader`, → `check` |
| `back-to-documents` | `check` | → `documents` |
| `reread-used { field }` | `check` | `kyc.rereads[field]` + 1 (capped at 2) |
| `check-confirmed { match, pan, fields }` | `check` | `identity.pan = pan`, `kyc.match`, pending review fields kept in `kyc.review` with `sentAt: ''`, → `aadhaar-otp` |
| `back-to-check` | `aadhaar-otp` | → `check` |
| `aadhaar-verified` | `aadhaar-otp` | → `done`; `kyc.status = match === 'matched' ? 'verified' : 'under-review'`; if review, `review.sentAt = at` |
| `review-decided { result, reason, at }` | `done` + `under-review` | `approved` → `verified`; `rejected` → `rejected` (reason required, 1–200 chars) |
| `redo-documents` | `done` + `rejected` | → `identity` (identity kept), `kyc` = `emptyKyc()` except history: previous `review` kept until the new one replaces it |

`identity-saved` from the Part A flow (`aadhaar-otp` directly) is no longer reachable. `done` still requires `aadhaar-verified` with 4 digits **and** `kyc.match !== null`.

## B5. Screens

| Step | Feature id | Content | Primary button |
|---|---|---|---|
| Upload documents | `onboard-documents` | 3 slots: "Your selfie", "Aadhaar card", "PAN card"; per-slot buttons (table B6); preview with "Replace"/"Remove"; hints; no demo UI (R7.2) | "Continue" (disabled until 3 valid files) |
| Reading | (inside `onboard-documents`) | "Reading your documents…" with `role="status"` / `accessibilityLiveRegion` | — |
| Check your numbers | `onboard-check` | Per field: "You typed", "Read from document", "Match" ✅ / "Doesn't match" ❌, thumbnail; Aadhaar full with Hide; on mismatch "Use number from document", "Edit number", "Upload again" (re-read limit shown as "N re-checks left") | "Confirm" |
| Aadhaar OTP | `onboard-aadhaar-otp` | unchanged; "Back" → Check numbers | "Verify Aadhaar" |
| Done | (inside `onboard-aadhaar-otp`) | Verified text (Req 9.2) or Under review text (Req 9.3) | "Go to Home" |
| Settings → Account | `onboard-account` + `onboard-review` | adds "Account status: Verified / Under review / Review rejected (reason)"; "Redo documents" when rejected | — |
| Settings → Demo reviewer | `onboard-review` | shown only when `reader.isDemo`; pending review: masked typed vs read per field; "Approve"; "Reject" with a reason field | "Approve" / "Reject" |

Messages (same on web and mobile): "Both numbers match your documents.", "The number you typed doesn't match your PAN card." / "…your Aadhaar card.", "We'll check this by hand.", "We couldn't read your PAN card. Upload a clearer photo or PDF." (and Aadhaar), "Allow camera access, or choose a file instead.", "Face the camera in good light. No cap or sunglasses.", "Fit the whole card in the frame. Avoid glare.".

## B6. Getting the files

| Slot | Web (desktop) | Android / iOS |
|---|---|---|
| Selfie | "Use webcam" (`getUserMedia({ video: { facingMode: 'user' } })` → canvas → JPEG blob; hidden if no camera) · "Upload from computer" (`<input type=file accept="image/jpeg,image/png" capture="user">`) | "Take photo" (`ImagePicker.launchCameraAsync({ cameraType: front })`) · "Choose from gallery" (`launchImageLibraryAsync`) |
| Aadhaar, PAN | "Upload from computer" (`accept="image/jpeg,image/png,application/pdf"`) · "Choose from Google Drive" | "Take photo" (back camera) · "Choose from gallery" · "Choose a file" (`DocumentPicker.getDocumentAsync({ type: ['image/jpeg','image/png','application/pdf'], copyToCacheDirectory: true })`, which lists Google Drive when the Drive app is installed) |

- Phones: add `expo-image-picker` **58.0.10** (pinned, matches Expo 58) to `apps/android` and `apps/ios`, and as a peer dependency of `packages/mobile-ui`. `expo-document-picker` 58.0.4 is already there. Add the `expo-image-picker` config plugin in both `app.json` files with `cameraPermission: "Wealthfire uses the camera for your KYC selfie and ID card photos."` and `photosPermission: "Wealthfire lets you pick your ID card photos from your gallery."`. Image picker options: `quality: 0.8`, `exif: false`, `preferredAssetRepresentationMode: Compatible` (so iOS gives JPEG, not HEIC).
- **Take photo flow (Req 7.11), phones:** call `ImagePicker.requestCameraPermissionsAsync()` first (system prompt). If denied and `canAskAgain` is false, show the 7.8 message with an "Open settings" button (`Linking.openSettings()`). Then `launchCameraAsync({ cameraType: Front, allowsEditing: false, quality: 0.8, exif: false })`; the OS camera screen gives Capture. Back in the app, the same "Retake" / "Crop" / "Use photo" screen as web. "Crop" is an in-app square crop (pan + pinch zoom with `PanResponder`, plus +/- buttons for accessibility), saved with `expo-image-manipulator` `manipulateAsync(uri, [{ crop }], { compress: 0.8, format: SaveFormat.JPEG })`. Adds `expo-image-manipulator` **58.0.16** (exact pin). Temporary files from capture and crop are deleted like other documents.
- **Take photo flow, web:** "Take photo" shows the one-line reason, then calls `getUserMedia({ video: { facingMode: 'user' } })` (browser prompt). Dialog: live video + "Capture" → still image with "Retake" / "Crop" / "Use photo". "Crop": in-page square crop (drag to move, slider + wheel/pinch to zoom, keyboard arrows and +/- for accessibility), drawn to a canvas and exported with `canvas.toBlob(..., 'image/jpeg', 0.85)`. No new library. Stream tracks are stopped when the dialog closes. If `getUserMedia` is missing or denied, show the 7.8 message.
- Phones, cleanup: picked files live in the app cache. `FileSystem.deleteAsync(uri, { idempotent: true })` runs on Remove/Replace, when onboarding completes, on sign-out and on unmount.
- Web, cleanup: files are `Blob`s with `URL.createObjectURL` previews; `URL.revokeObjectURL` on Remove/Replace/complete/unmount. Webcam stream tracks are stopped when the dialog closes.

### Google Drive picker (web)

- New `apps/web/src/drive.ts`, same pattern as `google.ts`: Google Identity Services token client with scope `https://www.googleapis.com/auth/drive.file` (only files the user picks), loaded `https://apis.google.com/js/api.js` → `gapi.load('picker')`, `DocsView` filtered to `image/jpeg,image/png,application/pdf`, then `GET https://www.googleapis.com/drive/v3/files/{id}?alt=media` with the token → `Blob`. Token in memory only, revoked after the pick.
- Config: `VITE_GOOGLE_CLIENT_ID` (exists), new `VITE_GOOGLE_API_KEY` and `VITE_GOOGLE_APP_ID` (Google Cloud project number), fed in CI from repo variables `GOOGLE_API_KEY` and `GOOGLE_APP_ID` (one-line change in `.github/workflows/ci-and-pages.yml`, build step env).
- If the key or app id is missing, the button is disabled with "Google Drive isn't set up yet. Upload from your computer instead."
- One-time setup Nitish does in Google Cloud: enable Google Picker API and Google Drive API, create an API key restricted to `https://nitishsana.github.io` and `http://127.0.0.1:5180`, add the `drive.file` scope to the existing OAuth consent screen, and set the two repo variables. Until then the button shows the message above; everything else works.

## B7. Security and privacy

- Documents and `FieldCheck` objects (with the full Aadhaar) stay in screen memory only. They are never put in `AppData`, so never in localStorage/AsyncStorage or the backup file. No `console.*`.
- The demo reader never sends files anywhere. The real reader will send files to the partner via our backend only, over HTTPS; the browser/phone never holds a partner secret.
- Review records keep masks only. The demo reviewer sees masks only (no documents, since they are not stored).
- Google Drive: `drive.file` scope only; no listing of the user's Drive; token never stored.
- Client-side limits as in Part A §7: a deliberate hand edit of storage can fake "Verified" until a server-side KYC check exists. `isEligibleToInvest` must be re-checked server-side by the future investment journey.

## B8. Testing (Vitest, `packages/core/test/kyc.test.ts`, `docreader.test.ts`; extend `onboarding.test.ts`)

| Area | Cases |
|---|---|
| `validateDocFile` | selfie PDF rejected; card PDF ok; 10 MB ok, 10 MB + 1 rejected; GIF rejected |
| Demo reader | each mode × each field; `misread` result is a valid PAN / Verhoeff-valid Aadhaar and differs from expected; strict `misread` returns expected; `different` never equals expected |
| `verhoeffCheckDigit` | builds `234123412346` from `23412341234` |
| Check logic | match → matched; mismatch + use document → matched; mismatch + edit + reread equal → matched; still differs → review; third reread blocked |
| Reducer | full path signin → done (verified); path with review (under-review); `review-decided` approve / reject (reason required); `redo-documents`; wrong-step events ignored; `done` impossible without `kyc.match` |
| Store | serialized data after a review path has no 12-digit run; old `done` without `kyc` lowered to `identity` |
| Eligibility | true only for done + verified |

UI checks: parity ids `onboard-documents`, `onboard-check`, `onboard-review`; preview walk-through of all 4 demo modes; `CMD files/01 - Onboarding.cmd` test-value comments updated.

## B9. Build plan (for tasks.md)

Same workflow as Part A: one orchestrator, builders in parallel with separate file ownership, then an independent reviewer, then all checks and the preview.

| Builder | Owns | Starts |
|---|---|---|
| A: core | `packages/core/**` | at once |
| B: web | `apps/web/**`, `.github/workflows/ci-and-pages.yml` (env lines only), `CMD files/01 - Onboarding.cmd` | at once, coding against B2–B4 signatures |
| C: phones | `packages/mobile-ui/**`, `apps/android/**`, `apps/ios/**` (App.tsx, app.json, package.json, lockfile) | at once, coding against B2–B4 signatures |


---

# Part C — Aadhaar verified once, and real on-device document reading (preview fixes, 2026-11-06)

Nitish's preview found: (1) Aadhaar felt verified twice; (2) the camera would not start (fixed in the current wave, see O2c/O3c); (3) wrong PDFs passed as a match, because the demo reader never looks at the file. Decision: **read documents on the device** (option A). Files never leave the device.

## C1. Flow: Aadhaar OTP once, before documents

```
signin → otp → identity → aadhaar-otp → documents → check → done
```

| Event | Change |
|---|---|
| `identity-saved` | → `aadhaar-otp` (again, as in Part A) |
| `aadhaar-verified` | stores last 4 + verifiedAt, → `documents` (no longer `done`) |
| `back-to-identity` | allowed from `aadhaar-otp` only; from `documents`/`check` the Aadhaar is locked |
| `check-confirmed` | → `done`; sets `kyc.match`, `kyc.status` (`verified` / `under-review`), `completedAt`, review `id` + `sentAt` |
| `back-to-check` | removed (no step after `check` but `done`) |
| `redo-documents` | → `documents` (no new OTP) |

- `done` requires `aadhaar` (OTP passed) **and** `kyc.match`.
- **Aadhaar on Check numbers is locked** to the OTP-verified number: no "Edit number", no "Use number from document" for Aadhaar; only "Upload again" (a re-read). Still differs after re-reads → manual review. PAN keeps all three choices.
- The full verified Aadhaar stays in screen memory from the OTP step to Check numbers. After a reload (or on Redo documents) it is gone, so Upload documents shows one extra field, "Enter your Aadhaar number again", which must pass Verhoeff and end in the verified last 4 ("This doesn't match the Aadhaar you verified."). No second OTP is ever sent.
- `sanitizeOnboarding`: steps past `aadhaar-otp` need `aadhaar`; `done` needs `kyc.match` and `kyc.status`.

## C2. On-device reader (`packages/core/src/cardtext.ts` + `docreader.ts`)

Core stays platform-free: it parses text; each platform supplies the text engine.

```ts
export type TextExtractor = (doc: DocFile, opts: { strict: boolean }) => Promise<string[]>; // one or more OCR passes
export function createOnDeviceReader(extract: TextExtractor): DocumentReader;        // id 'ondevice', isDemo false

export interface CardParse {
  looksLikeCard: boolean;      // card keywords found
  value: string | null;        // best valid number, normalized
  masked: boolean;             // Aadhaar shown as XXXX XXXX 1234
}
export function parsePanText(text: string): CardParse;
export function parseAadhaarText(text: string): CardParse;
```

- `DocReaderId` gains `'ondevice'`. `createDocumentReader`: `undefined` / `''` / `'ondevice'` → on-device reader (the new default everywhere); `'demo'` → demo reader (local dev scenario launchers only).
- **PAN rules:** keywords any of `INCOME TAX DEPARTMENT`, `Permanent Account Number`, `GOVT. OF INDIA`, `आयकर विभाग`. Candidates: 10-char tokens after removing spaces; fix common OCR swaps by position (letters at 1–5 and 10: `0→O, 1→I, 5→S, 8→B, 2→Z`; digits at 6–9: `O→0, I/L→1, S→5, B→8, Z→2`); must pass `validatePan` shape (4th char any valid type is still read, so a company PAN is reported, not silently matched).
- **Aadhaar rules:** keywords any of `Aadhaar`, `आधार`, `Unique Identification Authority`, `Government of India`, `भारत सरकार`. Candidates: 12 digits as `dddd dddd dddd` or `dddddddddddd`, first digit 2–9, Verhoeff valid; 16-digit VID numbers are ignored; `XXXX XXXX 1234` → `masked: true`.
- **Results:** no keywords → `{ ok: false, reason: 'invalid', message: 'This doesn't look like a PAN card. Upload your PAN card.' }` (Aadhaar: "…an Aadhaar card. Upload your Aadhaar card."); keywords but no valid number → `unreadable` (existing message); masked Aadhaar → `invalid`, "This Aadhaar is masked. Upload the full Aadhaar or the e-Aadhaar PDF."; several different valid numbers → the most frequent across passes, else `unreadable`.
- **Strict mode** (re-read): the extractor runs extra passes (2× scale, grey + threshold, and rotated 90°/180°/270° for sideways photos), and the parser takes the majority value.
- `expected` is never used by the on-device reader.

## C3. Web text engine (`apps/web/src/ocr.ts`)

- `tesseract.js` **7.0.0** (Apache-2.0) and `pdfjs-dist` **6.5.438** (Apache-2.0), exact pins, in `apps/web`.
- Self-hosted, no CDN: the Tesseract worker, core WASM and `eng` fast language data are copied into `apps/web/public/ocr/` by a small `scripts/copy-ocr-assets.mjs` run on `postinstall`/`prebuild`, and passed as `workerPath` / `corePath` / `langPath`. Loaded lazily on the first read (~5 MB, cached by the browser afterwards).
- PDF: `pdfjs-dist` renders page 1 at scale 2 to a canvas (worker via `pdfjs-dist/build/pdf.worker.min.mjs?url`); images are drawn to a canvas too. Passes as in C2; one Tesseract worker reused, terminated when onboarding completes.
- Screen shows "Reading your documents…" with a progress percentage from Tesseract's logger.

## C4. Phone text engine (`packages/mobile-ui/src/ocr.ts`)

- `@react-native-ml-kit/text-recognition` **2.0.0** (MIT) for images; `react-native-pdf-thumbnail` **2.0.0** (MIT) renders PDF page 1 to an image first; `expo-dev-client` **58.0.18**. All exact pins in both app folders, peers in `packages/mobile-ui`.
- These are native modules, so the phone apps need a **custom development build** (`npx expo run:android` / `run:ios`, or EAS `build:apk`). **Expo Go can no longer run the app.** CI's `expo export` (JS bundle) is unaffected.
- The modules are loaded with a guarded `require`. If they are missing (e.g. someone opens it in Expo Go), reading fails with "Document reading isn't available in this app build." and the step does **not** pass — it never falls back to a fake match.
- Strict passes: ML Kit on the original plus `expo-image-manipulator` resized (2×) and rotated copies; temp images deleted after reading.

## C5. Honesty and privacy

- No document ever "matches" without being read. The demo reader exists only behind DEV-only scenario switches.
- Text and images stay in memory; OCR text is never stored or logged. Only the parsed number reaches the check screen.
- Accuracy limit: clear, flat, well-lit photos read well; blurry or glared photos may be unreadable and ask for a clearer upload. A KYC partner can replace the on-device reader later through the same slot.

## C6. Tests

Core (`cardtext.test.ts`): sample OCR texts for a PAN card and an Aadhaar card (synthetic, using test numbers `ABCPE1234F`, `234123412346`), OCR swaps fixed (`ABCPE1Z34F` → digits fixed), wrong card (a PAN text given to the Aadhaar parser → not a card), random PDF text → not a card, VID ignored, masked Aadhaar, Verhoeff-failing 12-digit runs rejected, majority across passes. Reducer: new step order, `done` only via `check-confirmed` after `aadhaar-verified`, Aadhaar locked on check, re-type rule after reload. UI: the scenario launchers keep working through `?reader=demo&mode=…`; a new `01 - Onboarding (real reading).cmd` uses the on-device reader.

## C7. Build plan

Chief of Staff starts (sub-agents cannot start their own): **P1 core** (C1 reducer + C2 parser + tests, owns `packages/core/**`) first; then in parallel **P2 web flow** (`apps/web/src/pages/Onboarding.tsx`, `Settings.tsx`, `styles.css`), **P2o web OCR** (`apps/web/src/ocr.ts`, `apps/web/src/docreader.ts`, `apps/web/package.json` + lockfile, `scripts/copy-ocr-assets.mjs`, `apps/web/public/ocr/`, `.gitignore` line for copied assets), **P3 phone flow** (`packages/mobile-ui/src/screens/Onboarding.tsx`, `Documents.tsx`, `onboardUi.tsx`), **P3o phone OCR** (`packages/mobile-ui/src/ocr.ts`, `reader.tsx`, `packages/mobile-ui/package.json`, both app `package.json` + lockfiles + `app.json`); then the independent reviewer and all checks.
