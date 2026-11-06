# Tasks: Onboarding journey

Repo: `C:\Users\sananiti\.kiro\crew\workspace\wealthfire`, branch `feature/onboarding` (from `origin/main` @ `17aa781`).
Work stays local: commit on the branch, do not push, open a PR or merge until Nitish says yes (`.kiro/steering/git-workflow.md`).
Each task names the requirement (R) and design section (D) it covers.

## Phase 1 — Core data and rules (`packages/core`)

- [ ] 1. Add the data model
  - In `packages/core/src/types.ts` add `OnboardingStep`, `ContactKind`, `OtpProviderId`, `OnboardingState`, and `onboarding: OnboardingState` on `AppData`.
  - Covers R5.1, D2.

- [ ] 2. Store migration and safety
  - In `packages/core/src/store.ts` add `emptyOnboarding()` and `sanitizeOnboarding(raw)`; use them in `emptyData()` and `deserialize()`.
  - `sanitizeOnboarding` keeps known keys only, drops `aadhaar` unless `last4` matches `/^\d{4}$/`, and resets `step: 'done'` to `'aadhaar-otp'` when `aadhaar` is missing.
  - In `packages/core/src/demo.ts` set `onboarding: emptyOnboarding()` in `demoData()`.
  - Covers R4.6, R5.3, R5.4, D2.

- [ ] 3. Validators, masks and Verhoeff
  - Create `packages/core/src/onboarding.ts` with `normalizeEmail`, `validateEmail`, `normalizeMobile`, `validateMobile`, `validateName`, `normalizePan`, `validatePan`, `panSurnameWarning`, `normalizeAadhaar`, `validateAadhaar`, `verhoeffValid`, `maskEmail`, `maskMobile`, `maskPan`, `maskAadhaar`, `groupAadhaar`, using the exact rules and error texts in the D4 table.
  - Covers R1.3–R1.5, R2.1, R3.2–R3.6, R5.6.

- [ ] 4. OTP limits
  - In `onboarding.ts` add `OTP_RULES`, `pruneSends`, `canSend` (cooldown 30 s, 4 sends per 10 min, Aadhaar lock 30 min).
  - Covers R2.5–R2.7, R4.2, R4.9, D4.

- [ ] 5. Step reducer and helpers
  - In `onboarding.ts` add `OnboardingEvent`, `onboardingReducer` (transition table in D4; wrong-step events return state unchanged; `done` only via `aadhaar-verified`), `resumeStep`, `prefillProfileName`.
  - Covers R2.4, R3.8, R3.9, R4.3, R4.5, R4.6, R5.2, R5.6.

- [ ] 6. OTP provider slot and demo provider
  - Create `packages/core/src/otp.ts` with `OtpChannel`, `OtpSendRequest`, `OtpSendResult`, `OtpVerifyResult`, `OtpProvider`, `DemoOtpProvider` and `createOtpProvider` exactly as in D3.
  - Demo: random 6-digit code, 5-minute expiry, 5 tries then void, new send voids old for the same channel + target, Aadhaar target ending `0000` → `no-linked-mobile`, verify returns `aadhaarLast4`.
  - `createOtpProvider` returns the demo for `undefined`/`'demo'`, throws `OTP provider "<id>" is not built yet` otherwise.
  - Export both new modules from `packages/core/src/index.ts`.
  - Covers R2.3–R2.8, R4.2, R4.7, R4.8, D3.

- [ ] 7. Feature ids
  - In `packages/core/src/features.ts` add `onboard-signin`, `onboard-otp`, `onboard-identity`, `onboard-aadhaar-otp`, `onboard-account`, each named "Onboarding: …".
  - Covers R6.2.

- [ ] 8. Core tests
  - Create `packages/core/test/onboarding.test.ts` and `packages/core/test/otp.test.ts` with every case in the D8 table (use `234123412346` as the valid Aadhaar and `234123412347` as the bad checksum).
  - Include the store test that `serialize()` output after a full happy path has no 12-digit run (`/\d{12}/`).
  - Run `npm test` and `npm run typecheck`; both must pass.
  - Covers R6.1, R5.3.

## Phase 2 — Website (`apps/web`)

- [ ] 9. Provider instance
  - Create `apps/web/src/otp.ts`: `export const otpProvider = createOtpProvider({ provider: import.meta.env.VITE_OTP_PROVIDER, apiUrl: import.meta.env.VITE_OTP_API_URL })`.
  - Covers D3, D6.

- [ ] 10. Shared OTP step component
  - Create `apps/web/src/components/OtpStep.tsx` with the D5 contract: send via `canSend` then `provider.send`, demo banner when `isDemo`, 6-digit input (`inputMode="numeric"`, `autoComplete="one-time-code"`), "Resend in 0:SS" countdown, error messages from `OtpVerifyResult`, 1-second ticker cleared on unmount.
  - Covers R2.2–R2.8, R4.2, R6.4.

- [ ] 11. Onboarding page
  - Create `apps/web/src/pages/Onboarding.tsx` with the four steps and the "You're all set" screen, wording from D5, tags `data-feature="onboard-signin"`, `onboard-otp`, `onboard-identity`, `onboard-aadhaar-otp`.
  - Sign in: segmented Mobile (default) / Email, `+91` prefix, errors after blur, "Send OTP" disabled until valid.
  - Details: four fields, Aadhaar grouped + Show/Hide, consent checkbox, PAN surname soft warning; full Aadhaar kept in component state only and cleared on verify, Back and unmount.
  - Aadhaar OTP: target is the full Aadhaar, masked text, no skip, "Back", lock message.
  - Every state change goes through `update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, event) }))`.
  - Brand header and the disclaimer footer on every step. Styles added to `apps/web/src/styles.css` using existing CSS variables only.
  - Covers R1–R4, R6.3, R6.4, R6.7.

- [ ] 12. Gate in the web shell
  - In `apps/web/src/App.tsx` render `<OnboardingPage />` instead of the shell when `data.onboarding.step !== 'done'`; "Go to Home" navigates to `/`.
  - Covers R1.1, R4.4, R5.2.

- [ ] 13. Web Settings and Profile
  - `apps/web/src/pages/Settings.tsx`: add the "Account" card (`data-feature="onboard-account"`) with masked contact, PAN, Aadhaar, "Verified" and "Sign out" (dispatch `sign-out`); change "Load demo data" to `replace({ ...demoData(), onboarding: data.onboarding })`.
  - `apps/web/src/pages/Profile.tsx`: use `prefillProfileName(data)` as the name's start value when empty.
  - Covers R3.9, R5.5, R5.6.

## Phase 3 — Android and iOS (`packages/mobile-ui`, `apps/android`, `apps/ios`)

- [ ] 14. Provider config on phones
  - Add `otp?: { provider?: string; apiUrl?: string }` to `WealthfireAppProps` in `packages/mobile-ui/src/index.tsx`, create the provider once with `createOtpProvider`, and share it through a small context.
  - In `apps/android/App.tsx` and `apps/ios/App.tsx` pass `otp` from `Constants.expoConfig.extra` (same way as `google`). No `otpProvider` key is added to `app.json` in v1, so demo is used.
  - Covers D3, D6.

- [ ] 15. Onboarding screen
  - Create `packages/mobile-ui/src/screens/Onboarding.tsx` with the same steps, wording and rules as task 11, plus the local `OtpStep`.
  - Tags: `feature="onboard-signin"` etc. on each step's root (or `testID="feature-<id>"`).
  - Keyboards and a11y per D5: `number-pad` + `oneTimeCode`/`sms-otp`, `email-address`, `phone-pad`, `secureTextEntry` for hidden Aadhaar, `accessibilityLabel` on inputs, `accessibilityLiveRegion="polite"` on errors.
  - Use `theme` colors only.
  - Covers R1–R4, R6.3, R6.4, R6.7.

- [ ] 16. Gate in the phone shell
  - In `Body` (`packages/mobile-ui/src/index.tsx`) render `<OnboardingScreen />` with the header and no tab bar when `loaded && data.onboarding.step !== 'done'`; on finish call `setTab('home')`.
  - Covers R1.1, R4.4, R5.2.

- [ ] 17. Phone Settings and Profile
  - In `SettingsScreen` (`packages/mobile-ui/src/screens/Plan.tsx`) add the Account section (`testID="feature-onboard-account"`) and keep onboarding on "Load demo data".
  - In `ProfileScreen` (`packages/mobile-ui/src/screens/Core.tsx`) use `prefillProfileName`.
  - Covers R3.9, R5.5, R5.6.

## Phase 4 — Checks, preview, docs

- [ ] 18. Run every check
  - `npm test`, `npm run typecheck`, `npm run parity`, `npm run build`.
  - `cd apps/android && npx tsc --noEmit && npx expo export --platform android`.
  - `cd apps/ios && npx tsc --noEmit && npx expo export --platform ios`.
  - Fix anything that fails, then remove the Expo `dist` output folders created by the exports if they are not git-ignored.
  - Covers R6.5.

- [ ] 19. Manual walk-through on the local preview
  - `cd apps/web && npx vite --host 127.0.0.1 --port 5180`.
  - Check: fresh browser lands on sign-in; mobile and email paths; wrong code ×5 voids; resend countdown; reload mid-OTP needs a new code; bad PAN / company PAN / bad Aadhaar messages; Aadhaar `…0000` shows no-linked-mobile; 4 sends locks Aadhaar for 30 min and survives reload; success shows Home; localStorage and "Download backup" hold only `last4`; Settings Account masks and Sign out; Delete all data returns to sign-in; existing data survives onboarding.
  - Covers R1–R5.

- [ ] 20. Steering and commit
  - Add a short note to `.kiro/steering/project-overview.md` under Notes: OTPs go through `OtpProvider`; v1 is demo; full Aadhaar is never stored; real DigiLocker/Digio needs a backend.
  - Commit on `feature/onboarding` with message `Add onboarding: mobile/email OTP, identity details, mandatory Aadhaar OTP (demo provider)`.
  - Do not edit `FEATURES.md` yet (only merged features go there).
  - Ask Nitish to review the preview, then whether to push and merge with any other batched features.

- [ ] 21. After Nitish approves the merge
  - Push with `git push -u origin feature/onboarding`, open the PR into `main`, wait for CI (check, mobile android, mobile ios), merge.
  - Add the `## Onboarding` section with five rows to `FEATURES.md` (D9) ending `(PR #n)`, update "Last updated", and ship it in the same merge set.
  - Covers R6.6.
