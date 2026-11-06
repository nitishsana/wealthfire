# Tasks: Onboarding journey

Repo: `C:\Users\sananiti\.kiro\crew\workspace\wealthfire`, branch `feature/onboarding` (from `origin/main` @ `17aa781`).
Work stays local: commit on the branch, do not push, open a PR or merge until Nitish says yes (`.kiro/steering/git-workflow.md`).
Each task names the requirement (R) and design section (D) it covers.

## Phase 1 — Core data and rules (`packages/core`)

- [x] 1. Add the data model
  - In `packages/core/src/types.ts` add `OnboardingStep`, `ContactKind`, `OtpProviderId`, `OnboardingState`, and `onboarding: OnboardingState` on `AppData`.
  - Covers R5.1, D2.

- [x] 2. Store migration and safety
  - In `packages/core/src/store.ts` add `emptyOnboarding()` and `sanitizeOnboarding(raw)`; use them in `emptyData()` and `deserialize()`.
  - `sanitizeOnboarding` keeps known keys only, drops `aadhaar` unless `last4` matches `/^\d{4}$/`, and resets `step: 'done'` to `'aadhaar-otp'` when `aadhaar` is missing.
  - In `packages/core/src/demo.ts` set `onboarding: emptyOnboarding()` in `demoData()`.
  - Covers R4.6, R5.3, R5.4, D2.

- [x] 3. Validators, masks and Verhoeff
  - Create `packages/core/src/onboarding.ts` with `normalizeEmail`, `validateEmail`, `normalizeMobile`, `validateMobile`, `validateName`, `normalizePan`, `validatePan`, `panSurnameWarning`, `normalizeAadhaar`, `validateAadhaar`, `verhoeffValid`, `maskEmail`, `maskMobile`, `maskPan`, `maskAadhaar`, `groupAadhaar`, using the exact rules and error texts in the D4 table.
  - Covers R1.3–R1.5, R2.1, R3.2–R3.6, R5.6.

- [x] 4. OTP limits
  - In `onboarding.ts` add `OTP_RULES`, `pruneSends`, `canSend` (cooldown 30 s, 4 sends per 10 min, Aadhaar lock 30 min).
  - Covers R2.5–R2.7, R4.2, R4.9, D4.

- [x] 5. Step reducer and helpers
  - In `onboarding.ts` add `OnboardingEvent`, `onboardingReducer` (transition table in D4; wrong-step events return state unchanged; `done` only via `aadhaar-verified`), `resumeStep`, `prefillProfileName`.
  - Covers R2.4, R3.8, R3.9, R4.3, R4.5, R4.6, R5.2, R5.6.

- [x] 6. OTP provider slot and demo provider
  - Create `packages/core/src/otp.ts` with `OtpChannel`, `OtpSendRequest`, `OtpSendResult`, `OtpVerifyResult`, `OtpProvider`, `DemoOtpProvider` and `createOtpProvider` exactly as in D3.
  - Demo: random 6-digit code, 5-minute expiry, 5 tries then void, new send voids old for the same channel + target, Aadhaar target ending `0000` → `no-linked-mobile`, verify returns `aadhaarLast4`.
  - `createOtpProvider` returns the demo for `undefined`/`'demo'`, throws `OTP provider "<id>" is not built yet` otherwise.
  - Export both new modules from `packages/core/src/index.ts`.
  - Covers R2.3–R2.8, R4.2, R4.7, R4.8, D3.

- [x] 7. Feature ids
  - In `packages/core/src/features.ts` add `onboard-signin`, `onboard-otp`, `onboard-identity`, `onboard-aadhaar-otp`, `onboard-account`, each named "Onboarding: …".
  - Covers R6.2.

- [x] 8. Core tests
  - Create `packages/core/test/onboarding.test.ts` and `packages/core/test/otp.test.ts` with every case in the D8 table (use `234123412346` as the valid Aadhaar and `234123412347` as the bad checksum).
  - Include the store test that `serialize()` output after a full happy path has no 12-digit run (`/\d{12}/`).
  - Run `npm test` and `npm run typecheck`; both must pass.
  - Covers R6.1, R5.3.

## Phase 2 — Website (`apps/web`)

- [x] 9. Provider instance
  - Create `apps/web/src/otp.ts`: `export const otpProvider = createOtpProvider({ provider: import.meta.env.VITE_OTP_PROVIDER, apiUrl: import.meta.env.VITE_OTP_API_URL })`.
  - Covers D3, D6.

- [x] 10. Shared OTP step component
  - Create `apps/web/src/components/OtpStep.tsx` with the D5 contract: send via `canSend` then `provider.send`, demo banner when `isDemo`, 6-digit input (`inputMode="numeric"`, `autoComplete="one-time-code"`), "Resend in 0:SS" countdown, error messages from `OtpVerifyResult`, 1-second ticker cleared on unmount.
  - Covers R2.2–R2.8, R4.2, R6.4.

- [x] 11. Onboarding page
  - Create `apps/web/src/pages/Onboarding.tsx` with the four steps and the "You're all set" screen, wording from D5, tags `data-feature="onboard-signin"`, `onboard-otp`, `onboard-identity`, `onboard-aadhaar-otp`.
  - Sign in: segmented Mobile (default) / Email, `+91` prefix, errors after blur, "Send OTP" disabled until valid.
  - Details: four fields, Aadhaar grouped + Show/Hide, consent checkbox, PAN surname soft warning; full Aadhaar kept in component state only and cleared on verify, Back and unmount.
  - Aadhaar OTP: target is the full Aadhaar, masked text, no skip, "Back", lock message.
  - Every state change goes through `update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, event) }))`.
  - Brand header and the disclaimer footer on every step. Styles added to `apps/web/src/styles.css` using existing CSS variables only.
  - Covers R1–R4, R6.3, R6.4, R6.7.

- [x] 12. Gate in the web shell
  - In `apps/web/src/App.tsx` render `<OnboardingPage />` instead of the shell when `data.onboarding.step !== 'done'`; "Go to Home" navigates to `/`.
  - Covers R1.1, R4.4, R5.2.

- [x] 13. Web Settings and Profile
  - `apps/web/src/pages/Settings.tsx`: add the "Account" card (`data-feature="onboard-account"`) with masked contact, PAN, Aadhaar, "Verified" and "Sign out" (dispatch `sign-out`); change "Load demo data" to `replace({ ...demoData(), onboarding: data.onboarding })`.
  - `apps/web/src/pages/Profile.tsx`: use `prefillProfileName(data)` as the name's start value when empty.
  - Covers R3.9, R5.5, R5.6.

## Phase 3 — Android and iOS (`packages/mobile-ui`, `apps/android`, `apps/ios`)

- [x] 14. Provider config on phones
  - Add `otp?: { provider?: string; apiUrl?: string }` to `WealthfireAppProps` in `packages/mobile-ui/src/index.tsx`, create the provider once with `createOtpProvider`, and share it through a small context.
  - In `apps/android/App.tsx` and `apps/ios/App.tsx` pass `otp` from `Constants.expoConfig.extra` (same way as `google`). No `otpProvider` key is added to `app.json` in v1, so demo is used.
  - Covers D3, D6.

- [x] 15. Onboarding screen
  - Create `packages/mobile-ui/src/screens/Onboarding.tsx` with the same steps, wording and rules as task 11, plus the local `OtpStep`.
  - Tags: `feature="onboard-signin"` etc. on each step's root (or `testID="feature-<id>"`).
  - Keyboards and a11y per D5: `number-pad` + `oneTimeCode`/`sms-otp`, `email-address`, `phone-pad`, `secureTextEntry` for hidden Aadhaar, `accessibilityLabel` on inputs, `accessibilityLiveRegion="polite"` on errors.
  - Use `theme` colors only.
  - Covers R1–R4, R6.3, R6.4, R6.7.

- [x] 16. Gate in the phone shell
  - In `Body` (`packages/mobile-ui/src/index.tsx`) render `<OnboardingScreen />` with the header and no tab bar when `loaded && data.onboarding.step !== 'done'`; on finish call `setTab('home')`.
  - Covers R1.1, R4.4, R5.2.

- [x] 17. Phone Settings and Profile
  - In `SettingsScreen` (`packages/mobile-ui/src/screens/Plan.tsx`) add the Account section (`testID="feature-onboard-account"`) and keep onboarding on "Load demo data".
  - In `ProfileScreen` (`packages/mobile-ui/src/screens/Core.tsx`) use `prefillProfileName`.
  - Covers R3.9, R5.5, R5.6.

## Phase 4 — Checks, preview, docs

- [x] 18. Run every check
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


---

# Part B — Documents, number check and manual review (Requirements 7–9, design Part B)

Status of Part A: tasks 1–18 done and committed locally (`2a78ed7`, plus preview launchers `34730ea`, `75f08f9`, `e511e34`, `c111931`). Task 19 (Nitish's walk-through) and 20–21 stay open and are folded into tasks 41–44 so Part A and Part B ship together.

Workflow (`.kiro/steering/agent-workflow.md`): one orchestrator; Builders A, B, C run in parallel on separate files; then an independent reviewer; then checks and preview. Any open question goes to the orchestrator, who asks Nitish before that part is built.

## Phase 5 — Core (Builder A, owns `packages/core/**`)

- [ ] 22. Types: add `KycField`, `KycMatch`, `KycStatus`, `DocReaderId`, `ReviewRecord`, `KycState`; add `'documents' | 'check'` to `OnboardingStep`; add `kyc: KycState` to `OnboardingState`. (B1, B2)
- [ ] 23. Store: `emptyKyc()`, include it in `emptyOnboarding()`; `sanitizeOnboarding` rules from B2 (unknown kyc → empty, masks shape, rereads 0–2, `done` without `kyc.status` → `identity`). (B2, R5.4)
- [ ] 24. `onboarding.ts`: add `verhoeffCheckDigit(first11)`. (B3)
- [ ] 25. New `docreader.ts`: `DocKind`, `DocMime`, `DocFile`, `ReadOptions`, `ReadResult`, `DocumentReader`, `DemoReadMode`, `DemoDocumentReader` (4 modes per B3 table), `createDocumentReader`, `validateDocFile` with the exact error texts. Export from `index.ts`. (B3, R7.4–7.5, R8.1–8.2)
- [ ] 26. New `kyc.ts`: `MAX_REREADS`, `FieldCheck`, `compareField`, `initialChecks`, `takeDocumentNumber`, `applyReread`, `canReread`, `checkOutcome`, `reviewFields`, `isEligibleToInvest`, `kycStatusLabel`. Export from `index.ts`. (B4, R8.3–8.9, R9.4)
- [ ] 27. Reducer: change `identity-saved` → `documents`; add `documents-ready`, `back-to-documents`, `reread-used`, `check-confirmed`, `back-to-check`, `review-decided`, `redo-documents`; `aadhaar-verified` sets `kyc.status` and `review.sentAt`; `done` requires `kyc.match`. Update the Part A tests that expected `identity-saved` → `aadhaar-otp`. (B4 table, R4.5, R9.1–9.6)
- [ ] 28. Feature ids: `onboard-documents`, `onboard-check`, `onboard-review` in `features.ts`, names starting "Onboarding: …". (R6.2)
- [ ] 29. Tests: new `docreader.test.ts`, `kyc.test.ts`, extended `onboarding.test.ts`, every case in the B8 table. `npm test` and `npm run typecheck -w @wealthfire/core` pass.

## Phase 6 — Website (Builder B, owns `apps/web/**`, CI env lines, `CMD files/01 - Onboarding.cmd`)

- [ ] 30. `apps/web/src/docreader.ts`: one `documentReader` from `createDocumentReader({ reader: import.meta.env.VITE_DOC_READER, apiUrl: import.meta.env.VITE_DOC_READER_URL })`; add the env types to `vite-env.d.ts`.
- [ ] 31. `apps/web/src/drive.ts`: Google Picker per B6 (`drive.file` scope, `DocsView` mime filter, download to `Blob`, token in memory, revoke after pick); `isDriveConfigured()` checks `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`, `VITE_GOOGLE_APP_ID`; add env types. (R7.3)
- [ ] 32. `components/DocSlot.tsx`: one slot with "Upload from computer" (`accept` per kind), "Choose from Google Drive" (cards only; disabled message when not configured), "Use webcam" (selfie only; `getUserMedia` dialog → JPEG; stream stopped on close; hidden if no camera); validation via `validateDocFile`; preview (image thumbnail, or PDF icon + name + size); "Replace"/"Remove"; object URLs revoked. (R7.2–7.10)
- [ ] 33. `pages/Onboarding.tsx`: new `documents` step (`data-feature="onboard-documents"`, 3 `DocSlot`s, hints, demo reader mode picker when `isDemo`, "Continue" → "Reading your documents…" → reads PAN and Aadhaar → `documents-ready`) and `check` step (`data-feature="onboard-check"`, table per B5, "Use number from document" / "Edit number" / "Upload again", re-read via strict read + `reread-used`, "N re-checks left", "Confirm" → `check-confirmed` then send the Aadhaar OTP for the final number). Move the first Aadhaar OTP send from Your details to Confirm. Back on Aadhaar OTP → `back-to-check`. Reload on documents/check/aadhaar-otp → `back-to-identity`. Done screen shows Verified or Under review text. Documents and `FieldCheck`s in state only, cleared on done/sign-out/unmount. (R7–R9, R4.5)
- [ ] 34. `pages/Settings.tsx`: Account card shows status via `kycStatusLabel` (+ reject reason) and "Redo documents" when rejected (`data-feature="onboard-review"` on the status block); new "Demo reviewer" card (only when `documentReader.isDemo`) with masked fields, "Approve", "Reject" + reason (1–200 chars). (R9.5–9.7)
- [ ] 35. `preview.ts`: preview data sets `kyc` to verified (`match: 'matched'`, `status: 'verified'`, `reader: 'demo'`).
- [ ] 36. CI: in `.github/workflows/ci-and-pages.yml` build step env add `VITE_GOOGLE_API_KEY: ${{ vars.GOOGLE_API_KEY }}` and `VITE_GOOGLE_APP_ID: ${{ vars.GOOGLE_APP_ID }}`. Nothing else in the workflow changes.
- [ ] 37. `CMD files/01 - Onboarding.cmd`: update the `REM` test notes (demo reader modes; which mode shows each scenario). `npm run typecheck -w @wealthfire/web`, `npm run build`, `npm run parity` pass.

## Phase 7 — Android and iOS (Builder C, owns `packages/mobile-ui/**`, `apps/android/**`, `apps/ios/**`)

- [ ] 38. Dependencies: add `"expo-image-picker": "58.0.10"` (exact) to `apps/android/package.json` and `apps/ios/package.json`, run `npm install` in each app folder so the lockfiles update; add `expo-image-picker` to `packages/mobile-ui` peer dependencies; add the `expo-image-picker` plugin with the B6 permission texts to both `app.json` files.
- [ ] 39. Reader config + context like the OTP provider (`docReader` / `docReaderUrl` from `appJson.expo.extra`, optional). New `DocSlot` in `packages/mobile-ui/src/screens/Onboarding.tsx` (or a new `screens/Documents.tsx`): "Take photo" (front camera for selfie), "Choose from gallery", "Choose a file" for cards; permission-denied message; picker options from B6; preview; Replace/Remove; cache files deleted with `FileSystem.deleteAsync(..., { idempotent: true })` on Remove/Replace/done/sign-out/unmount.
- [ ] 40. Mobile `documents` and `check` steps, done-screen texts, Back/reload behaviour, Settings Account status + Redo documents + Demo reviewer card — same wording and rules as tasks 33–34, tagged `feature="onboard-documents"`, `feature="onboard-check"`, `testID="feature-onboard-review"`. `npx tsc --noEmit` passes in both app folders.

## Phase 8 — Review, checks, preview, ship (orchestrator)

- [ ] 41. Independent reviewer (not a builder): check Part A + Part B code against `requirements.md`, `design.md`, `tasks.md`; report per task, requirement gaps, bugs with severity, and web vs mobile wording differences. Send gaps back to the owning builder; re-check.
- [ ] 42. All checks: `npm test`, `npm run typecheck`, `npm run parity`, `npm run build`, both `npx tsc --noEmit`, both `npx expo export`. Then a local commit on `feature/onboarding`.
- [ ] 43. Nitish previews with `CMD files\01 - Onboarding.cmd` (all 4 demo reader modes, all 3 scenarios, Demo reviewer approve/reject, Redo documents) and the section files. Add the `project-overview.md` note from task 20 (OtpProvider + DocumentReader slots, full Aadhaar and documents never stored, real partners need a backend).
- [ ] 44. On Nitish's yes: full-flow bug check (web, Android, iOS) with every bug listed as must fix / should fix / minor; no merge with a must-fix open; push `feature/onboarding` with `git push -u origin feature/onboarding`, PR, CI green, merge; then the `## Onboarding` section in `FEATURES.md` (8 rows: the 5 Part A ids + `onboard-documents`, `onboard-check`, `onboard-review`) in the same merge set. (R6.6, task 21)
