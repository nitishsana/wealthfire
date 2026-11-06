# Requirements: Onboarding journey

## Introduction

Wealthfire (repo `github.com/nitishsana/wealthfire`, built from `origin/main` at commit `17aa781`, branch `feature/onboarding`) today opens straight on Home. There is no sign-in and no identity check. This feature adds an **Onboarding** journey that a new user completes before using the app:

1. Sign in with an email address **or** a mobile number.
2. Verify it with a one-time password (OTP).
3. Enter profile identity details: first name, last name, PAN, Aadhaar number.
4. Verify Aadhaar with an OTP sent to the Aadhaar-linked mobile.

**Change request (2026-11-06, Nitish) — adds Requirements 7–9.** KYC needs three documents, all mandatory: a selfie, the Aadhaar card and the PAN card. They are uploaded **after "Your details"** is complete. A **document reader agent** reads the PAN and Aadhaar numbers from the uploads and compares them with the numbers the user typed. The match is settled **before** the account status is confirmed.

New flow (changed again by Nitish after preview testing, 2026-11-06 — **Aadhaar is verified only once**): Sign in → Contact OTP → Your details (typed) → **Aadhaar OTP** (the one and only Aadhaar verification) → **Upload documents** → **Check numbers** → Account status.

Consequences: the Aadhaar number is locked once its OTP passes. On Check numbers the Aadhaar can only be matched by re-uploading the Aadhaar document (re-read); it cannot be edited and "Use number from document" is not offered for Aadhaar. If the Aadhaar document still does not match the verified number, the account goes to **Manual review**. PAN keeps all three choices. No second Aadhaar OTP is ever sent.

| # | What happens | Result |
|---|---|---|
| 1 | Numbers read from the documents match the typed numbers; user confirms | Profile **Verified** |
| 2 | They differ; user corrects a number (or re-uploads) → agent re-reads the document → re-read matches the final number | Profile **Verified** |
| 3 | They differ; after correction the agent's re-read still differs from the final number | Sent to **Manual review** |

Only a Verified profile will be eligible to invest. Investing itself belongs to the later investment journey and is out of scope here.

All of it ships on web, Android and iOS with the same wording, and is logged under a new **Onboarding** category in `FEATURES.md`.

### Constraints taken from the repo

- Logic lives only in `packages/core`, with tests (`project-overview.md`).
- Every feature id goes in `packages/core/src/features.ts`; `scripts/check-parity.mjs` fails if any platform misses it.
- Data stays on the device. There is no server today.
- The id `onboarding` is already taken by the Profile page (name, age, income). New ids must not reuse it.

### Assumptions (open decisions, see chat)

- **A1 – OTP delivery (confirmed by Nitish: demo now, DigiLocker/Digio slot later).** The app has no server, so real SMS/email OTP and UIDAI Aadhaar OTP cannot be sent from the device alone. This spec assumes a **pluggable OTP provider**: v1 ships a **demo provider** that runs on the device and shows the code on screen, clearly labelled "Demo". A real provider (for example Firebase Auth for email/phone, and a licensed Aadhaar KYC partner such as Setu or Digio) can be plugged in later without changing screens.
- **A2 – Aadhaar storage (confirmed by Nitish).** The full Aadhaar number is never saved. It is held in memory only until the Aadhaar OTP is checked. After that only the last 4 digits, a verified flag and the time are kept.
- **A4 – Aadhaar OTP is mandatory (confirmed by Nitish).** Onboarding cannot complete without a correct OTP sent to the mobile linked to the Aadhaar. There is no skip, no "verify later" and no fallback to PAN-only.

### How similar apps do it (researched 2026-11-06)

| App | Contact step | Aadhaar step | Who sends the Aadhaar OTP |
|---|---|---|---|
| Zerodha | Mobile OTP, then email OTP | PAN + Aadhaar via DigiLocker (Aadhaar OTP), then Aadhaar OTP eSign | UIDAI, via DigiLocker and Digio |
| Groww | Mobile or email OTP | DigiLocker KYC, then eSign with Aadhaar OTP | UIDAI, via DigiLocker and Digio |
| Paytm Money | Mobile OTP | Consent to DigiLocker, enter Aadhaar, Aadhaar OTP | UIDAI, via DigiLocker |

What this spec copies: contact OTP first, then identity, then an Aadhaar OTP that is mandatory, with explicit consent and only masked Aadhaar shown afterwards. What none of them do: send the Aadhaar OTP from the app itself. The OTP always comes from UIDAI through a licensed partner (DigiLocker, Digio). So a real Aadhaar check needs a partner account and a small server; the v1 demo provider stands in for it (see A1).

Sources: [Zerodha account opening](https://support.zerodha.com/category/account-opening/resident-individual/ri-online/articles/what-documents-do-i-need-to-open-an-account), [Zerodha PAN and Aadhaar via DigiLocker](https://support.zerodha.com/category/account-opening/resident-individual/ri-online/articles/pan-aadhaar-digilocker), [Zerodha customer verification](https://zerodha.com/z-connect/general/customer-verification-at-zerodha), [Groww DigiLocker and eSign](https://groww.in/blog/digilocker-and-esign-a-boon-for-indian-fintech), [Groww mutual fund KYC](https://groww.in/p/mutual-fund-kyc), [Paytm Money DigiLocker KYC](https://www.paytmmoney.com/blog/easy-kyc-on-paytm-money-with-digilocker/), [Paytm Money account opening steps (Finology)](https://select.finology.in/broker/paytm-money/account-opening-process). Content was rephrased for compliance with licensing restrictions.
- **A3 – Gate.** Onboarding is required on first launch. Existing users with data already on the device are asked to complete it once, but their data is kept.

## Glossary

| Term | Meaning |
|---|---|
| Contact | The email address or mobile number the user signs in with |
| OTP | 6-digit one-time password |
| OTP provider | Core interface that sends and checks OTPs; v1 = demo provider |
| PAN | 10-character Indian tax ID, format `AAAAA9999A` |
| Aadhaar | 12-digit Indian ID number, first digit 2–9, Verhoeff check digit |
| Onboarding state | Saved progress: which step is done, verified contact, identity details |

## Requirements

### Requirement 1: Choose sign-in method

**User story:** As a new user, I want to sign in with either my email or my mobile number, so that I can use whichever I have handy.

**Acceptance criteria**

1. WHEN the app opens and onboarding is not complete THEN the system SHALL show the Onboarding sign-in screen instead of Home, on web, Android and iOS.
2. The sign-in screen SHALL offer two choices: "Email" and "Mobile number", with "Mobile number" selected by default.
3. WHEN "Email" is chosen THEN the system SHALL accept an address matching `local@domain.tld` (trimmed, lower-cased, max 254 characters).
4. WHEN "Mobile number" is chosen THEN the system SHALL show a fixed `+91` prefix and accept exactly 10 digits starting with 6, 7, 8 or 9. Spaces and dashes typed by the user SHALL be ignored.
5. WHEN the input is not valid THEN the system SHALL keep "Send OTP" disabled and show a one-line error under the field after the field loses focus.
6. WHEN the user taps "Send OTP" with a valid contact THEN the system SHALL request an OTP from the OTP provider and move to the OTP screen.

### Requirement 2: Verify contact with OTP

**User story:** As a new user, I want to confirm my email or mobile with a code, so that the app knows the contact is mine.

**Acceptance criteria**

1. The OTP screen SHALL show the masked contact (`n****@gmail.com` or `+91 ******3210`) and a "Change" link back to Requirement 1.
2. The OTP field SHALL accept exactly 6 digits and SHALL support paste and the phone's one-time-code autofill.
3. WHEN the demo provider is active THEN the system SHALL show a "Demo code: 123456"-style banner with the generated code, labelled as demo.
4. WHEN the entered OTP matches and is not expired THEN the system SHALL mark the contact as verified, save the time, and move to the Profile details step.
5. An OTP SHALL expire 5 minutes after it is sent. WHEN an expired OTP is entered THEN the system SHALL show "Code expired. Send a new one."
6. WHEN a wrong OTP is entered THEN the system SHALL show "Wrong code. N tries left." The user SHALL get 5 tries per code; after 5 wrong tries the code SHALL be void and a new one must be sent.
7. "Resend OTP" SHALL be disabled for 30 seconds after each send, with a visible countdown. At most 3 resends per 10 minutes are allowed; after that the system SHALL show "Too many tries. Try again in M minutes."
8. A newly sent OTP SHALL make every earlier OTP for that contact invalid.

### Requirement 3: Enter profile identity details

**User story:** As a verified user, I want to enter my name, PAN and Aadhaar, so that my account is tied to my identity.

**Acceptance criteria**

1. The Profile details screen SHALL ask for First name, Last name, PAN and Aadhaar number. All four are required.
2. First name and Last name SHALL each be 1–50 characters of letters, spaces, apostrophes, dots or hyphens, trimmed.
3. PAN SHALL be auto-upper-cased and SHALL match `^[A-Z]{3}[ABCFGHLJPT][A-Z][0-9]{4}[A-Z]$`. For an individual user the 4th character SHALL be `P`; any other valid type SHALL show "This looks like a non-individual PAN. Use your personal PAN."
4. PAN's 5th character SHOULD match the first letter of the last name. WHEN it does not THEN the system SHALL show a soft warning ("PAN's 5th letter usually matches your last name") but SHALL still allow Continue.
5. Aadhaar SHALL be shown in groups as `XXXX XXXX XXXX`, accept 12 digits, reject a first digit of 0 or 1, and SHALL pass the Verhoeff checksum. WHEN it fails THEN the system SHALL show "Enter a valid 12-digit Aadhaar number."
6. Aadhaar SHALL be masked after entry (`XXXX XXXX 1234`) with a show/hide toggle.
7. The screen SHALL include a consent checkbox: "I agree to share my Aadhaar for OTP verification." Continue SHALL stay disabled until it is ticked and all fields are valid.
8. WHEN Continue is tapped THEN the system SHALL save first name, last name and PAN, keep the full Aadhaar in memory only, and move to Upload documents (Requirement 7). (Changed by the 2026-11-06 change request; it used to move straight to Aadhaar OTP.) **(Superseded by the "Aadhaar verified once" flow: see the flow paragraph at the top and design C1 — Your details → Aadhaar OTP → Upload documents → Check numbers → Confirm completes onboarding; the Aadhaar OTP never repeats and is never re-sent for a changed number, because the Aadhaar is locked after the OTP.)**
9. WHEN the Wealthfire Profile page later opens and its name is empty THEN it SHALL be pre-filled with "First Last" from this step.

### Requirement 4: Verify Aadhaar with OTP

**User story:** As a user, I want to confirm my Aadhaar with the OTP sent to my Aadhaar-linked mobile, so that my identity is checked.

**Acceptance criteria**

1. The Aadhaar OTP screen SHALL say "Enter the OTP sent to the mobile linked with Aadhaar XXXX XXXX 1234."
2. It SHALL follow the same OTP rules as Requirement 2 (6 digits, 5-minute expiry, 5 tries, 30-second resend, 3 resends per 10 minutes, demo banner).
3. WHEN the OTP is correct THEN the system SHALL store only the last 4 Aadhaar digits, a "verified" flag and the verified time, SHALL drop the full number from memory, and SHALL mark onboarding complete. **(Superseded by the "Aadhaar verified once" flow: see the flow paragraph at the top and design C1 — Your details → Aadhaar OTP → Upload documents → Check numbers → Confirm completes onboarding; the Aadhaar OTP never repeats and is never re-sent for a changed number, because the Aadhaar is locked after the OTP.)**
4. WHEN onboarding completes THEN the system SHALL show a "You're all set" screen with a "Go to Home" button that opens Home. **(Superseded by the "Aadhaar verified once" flow: see the flow paragraph at the top and design C1 — Your details → Aadhaar OTP → Upload documents → Check numbers → Confirm completes onboarding; the Aadhaar OTP never repeats and is never re-sent for a changed number, because the Aadhaar is locked after the OTP.)**
5. A "Back" link SHALL return to Check numbers (Requirement 8) with the documents and final numbers kept for this session. If the app was reloaded, the full Aadhaar and documents are gone, so it SHALL return to Profile details with first name, last name and PAN kept and the Aadhaar field empty. **(Superseded by the "Aadhaar verified once" flow: see the flow paragraph at the top and design C1 — Your details → Aadhaar OTP → Upload documents → Check numbers → Confirm completes onboarding; the Aadhaar OTP never repeats and is never re-sent for a changed number, because the Aadhaar is locked after the OTP.)**
6. This step SHALL be mandatory. The screen SHALL have no skip, "later" or close option, and onboarding SHALL NOT be marked complete until this OTP passes.
7. The OTP SHALL be requested through the OTP provider's Aadhaar channel, which represents the OTP UIDAI sends to the Aadhaar-linked mobile. It SHALL NOT be sent to the contact verified in Requirement 2, even if the numbers match.
8. WHEN the Aadhaar has no linked mobile (provider says so) THEN the system SHALL show "Your Aadhaar has no linked mobile. Link one at an Aadhaar centre, then try again." and SHALL keep onboarding incomplete.
9. WHEN 5 wrong tries or 3 resends are used up THEN the system SHALL lock this step for 30 minutes and show the time left. The rest of the app SHALL stay locked too.

### Requirement 5: Save and resume progress

**User story:** As a user, I want my progress kept if I close the app, so that I don't start again.

**Acceptance criteria**

1. The system SHALL save onboarding state on the device after each step, in the same store as other app data.
2. WHEN the app reopens mid-onboarding THEN the system SHALL resume at the first step not yet done. An unverified OTP SHALL NOT survive a restart; the user must send a new one.
3. The full Aadhaar number and any OTP value SHALL never be written to device storage, the backup download, or logs.
4. Existing saved data from before this feature SHALL load without loss. Its onboarding state SHALL start as "not started".
5. "Delete all data" in Settings SHALL also clear onboarding state and return the user to the sign-in screen.
6. Settings SHALL show the verified contact (masked), PAN (masked as `ABCPX****Z`) and Aadhaar (`XXXX XXXX 1234`) under a new "Account" section, with a "Sign out" button that clears onboarding state but keeps financial data.

### Requirement 6: Same on every platform, logged as Onboarding

**User story:** As the owner, I want onboarding to look and behave the same on web, Android and iOS, and to be tracked as its own category.

**Acceptance criteria**

1. All validation and OTP logic SHALL live in `packages/core` with unit tests covering every rule in Requirements 1–5.
2. New feature ids SHALL be added to `packages/core/src/features.ts`: `onboard-signin`, `onboard-otp`, `onboard-identity`, `onboard-aadhaar-otp`, `onboard-account` (the Settings "Account" section), plus for the change request `onboard-documents` (Req 7), `onboard-check` (Req 8) and `onboard-review` (Req 9). Each SHALL be tagged on web (`data-feature`) and mobile (`feature` / `testID`) so `npm run parity` passes.
3. Screen wording SHALL be identical on web and mobile.
4. All fields SHALL have visible labels, error text linked to the field for screen readers, and keyboard types (`email`, `phone-pad`, `number-pad`) set on mobile.
5. `npm test`, `npm run typecheck`, `npm run parity`, `npm run build` and both Expo exports SHALL pass.
6. When merged, `FEATURES.md` SHALL gain an **Onboarding** section with one row per feature id, ending `(PR #n)`.
7. The not-advice disclaimer SHALL stay visible on onboarding screens.

### Requirement 7: Upload selfie, Aadhaar and PAN (mandatory KYC documents)

**User story:** As a new user, I want to add my selfie, Aadhaar card and PAN card from my camera, gallery or files, so that my KYC is complete.

**Acceptance criteria**

1. WHEN "Your details" (Requirement 3) is saved THEN the system SHALL show the "Upload documents" step with three required slots, in order: "Your selfie", "Aadhaar card", "PAN card". There SHALL be no skip.
2. **Simple layout (Nitish, 2026-11-06).** The step SHALL show only three sections: "1. Your selfie" with "Take photo" and "Upload"; "2. Aadhaar card" with "Upload"; "3. PAN card" with "Upload". No demo labels, reader modes or other internal options SHALL appear on this screen.
3. "Upload" SHALL open the platform chooser: on phones, gallery or files (Google Drive included when its app is installed); on web, a computer file, with a small "or choose from Google Drive" link under the card buttons. On web, "Take photo" uses the webcam, and on a phone browser it opens the front camera. The demo reader mode is a developer setting only (design B3), never shown to users.
4. The selfie SHALL be a live camera photo or a JPG/PNG image. It SHALL open the front camera by default and show the hint "Face the camera in good light. No cap or sunglasses."
5. Aadhaar and PAN SHALL accept JPG, PNG or PDF, up to 10 MB each. A PDF SHALL be read from its first page. Other files SHALL be rejected with "Use a JPG, PNG or PDF under 10 MB."
6. The Aadhaar slot SHALL accept the front side, or the full e-Aadhaar PDF. Card slots SHALL show the hint "Fit the whole card in the frame. Avoid glare."
7. WHEN a file is added THEN the system SHALL show a preview (image thumbnail, or for a PDF a document icon with its file name and size) with "Replace" and "Remove".
8. WHEN camera permission is denied THEN the system SHALL show "Allow camera access, or choose a file instead." and keep the other options working.
9. "Continue" SHALL stay disabled until all three documents are added.
10. Documents SHALL be kept in memory only for the session (design A5). They SHALL never be written to app storage, the backup file or logs, and SHALL be dropped when onboarding completes, on sign-out and on reload.
11. **Take photo flow (Nitish, 2026-11-06).** WHEN the user taps "Take photo" THEN:
    1. If camera access was not granted before, the system SHALL ask for it with the platform prompt (phone: system permission dialog; browser: the site camera prompt). Before the prompt, a short line SHALL say "Wealthfire needs your camera to take your KYC selfie."
    2. WHEN access is allowed THEN the camera SHALL open (front camera) with a "Capture" button.
    3. WHEN a photo is captured THEN the system SHALL show it with "Retake", "Crop" and "Use photo".
    4. "Crop" SHALL let the user move and zoom the photo inside a square frame, then "Done" (keeps the crop) or "Cancel" (back to the uncropped photo).
    5. Only "Use photo" SHALL add the (cropped) photo to the slot as a JPEG; it then shows as the slot preview with "Replace" and "Remove".
    6. WHEN access is denied THEN Requirement 7.8 applies; "Upload" keeps working.

### Requirement 8: Agent reads the documents and checks the numbers

**User story:** As a new user, I want the app to read my numbers from the documents and check them against what I typed, so mistakes are caught before my account opens.

**Acceptance criteria**

1. WHEN "Continue" is tapped on Upload documents THEN the document reader agent SHALL read the PAN number from the PAN document and the Aadhaar number from the Aadhaar document, showing "Reading your documents…".
2. WHEN a document cannot be read, or what is read fails the PAN / Aadhaar checks from Requirement 3 THEN the system SHALL name the document and ask for a clearer one: "We couldn't read your PAN card. Upload a clearer photo or PDF."
3. The "Check your numbers" screen SHALL show, for PAN and for Aadhaar: the number typed, the number read from the document, and a "Match" or "Doesn't match" label, next to a thumbnail. Aadhaar SHALL show in full on this screen only, with a Hide option.
4. **Scenario 1** — WHEN both numbers match THEN the screen SHALL show "Both numbers match your documents." with "Confirm". Confirm SHALL mark the identity **Matched** and go to the Aadhaar OTP (Requirement 4). **(Superseded by the "Aadhaar verified once" flow: see the flow paragraph at the top and design C1 — Your details → Aadhaar OTP → Upload documents → Check numbers → Confirm completes onboarding; the Aadhaar OTP never repeats and is never re-sent for a changed number, because the Aadhaar is locked after the OTP.)**
5. WHEN a number does not match THEN the screen SHALL say "The number you typed doesn't match your {document}." and offer "Use number from document", "Edit number" and "Upload again".
6. **Scenario 2** — WHEN the user picks "Use number from document" THEN that number SHALL become the final number and count as matched. WHEN the user edits the number or uploads again THEN the agent SHALL re-read the document (stricter mode, looking again at the differing characters). WHEN the re-read equals the final number THEN that field counts as matched. WHEN all fields match THEN Confirm SHALL mark the identity **Matched**.
7. **Scenario 3** — WHEN after a re-read a field still differs THEN the screen SHALL say "We'll check this by hand." Confirm SHALL mark the identity **Needs manual review**, record which fields differ, and go to the Aadhaar OTP. Confirm SHALL also be allowed on a mismatch the user has not tried to fix; that too goes to manual review (Nitish, 2026-11-06). **(Superseded by the "Aadhaar verified once" flow: see the flow paragraph at the top and design C1 — Your details → Aadhaar OTP → Upload documents → Check numbers → Confirm completes onboarding; the Aadhaar OTP never repeats and is never re-sent for a changed number, because the Aadhaar is locked after the OTP.)**
8. The agent SHALL make at most 2 re-reads per document. After that any remaining mismatch goes to manual review without another re-read.
9. The final numbers SHALL replace the typed ones in the saved identity (PAN in full; Aadhaar last 4 only, Requirement 4.3), and the Aadhaar OTP SHALL be sent for the final Aadhaar number. **(Superseded by the "Aadhaar verified once" flow: see the flow paragraph at the top and design C1 — Your details → Aadhaar OTP → Upload documents → Check numbers → Confirm completes onboarding; the Aadhaar OTP never repeats and is never re-sent for a changed number, because the Aadhaar is locked after the OTP.)**

### Requirement 9: Account status and manual review

**User story:** As a user, I want to know whether my account is open and verified, or under review.

**Acceptance criteria**

1. The account status SHALL be confirmed only after both the number check (Requirement 8) and the Aadhaar OTP (Requirement 4) are done.
2. WHEN the identity is **Matched** and the Aadhaar OTP passes THEN the status SHALL be **Verified**, and the done screen SHALL say "Your account is open and verified. You can start investing once investing opens in Wealthfire."
3. WHEN the identity **Needs manual review** and the Aadhaar OTP passes THEN the status SHALL be **Under review**, and the done screen SHALL say "Your account is open. We're checking your details by hand, usually within 1 working day. You can use the planner meanwhile."
4. In both cases onboarding is complete and the planner (all current tabs) opens. Investing eligibility SHALL be exposed as `isEligibleToInvest(data)`, true only for **Verified**, for the later investment journey.
5. Settings → Account SHALL show the status as "Verified", "Under review" or "Review rejected", with the reason when rejected.
6. The demo "Demo reviewer" card SHALL appear only in local development builds (web `import.meta.env.DEV`, phones `__DEV__`), never on the live site or release apps, so users cannot approve their own review (Nitish, 2026-11-06). On the live site "Under review" waits for a real review team (out of scope here). A review SHALL end as "Approve" (status → Verified) or "Reject with reason" (status → Review rejected; the user can redo Upload documents and Check numbers from Settings → Account, "Redo documents").
7. Review records SHALL hold: masked numbers typed, masked numbers read, which fields differ, time sent. They SHALL never hold the full Aadhaar.

## Out of scope (this feature)

- Face match between the selfie and the Aadhaar photo, and liveness checks.
- The investment journey itself (orders, SIP set-up, mandates).

- Real SMS, email or UIDAI OTP delivery and any server or paid provider (only the provider interface is built).
- PAN verification against the Income Tax database, PAN–Aadhaar link check, and CKYC/KRA lookups.
- Password login, social login (Google/Apple), and multi-device account sync.
- Video KYC. (Selfie and document upload moved into scope by Requirement 7.)


## Change request 2026-11-06 (Nitish): name check on both cards

1. WHEN the PAN or Aadhaar document is read THEN the system SHALL also check that the name on the card matches the first and last name typed in "Your details" (case-insensitive, letters only; every surname word and the first given name must appear; one-letter OCR slips allowed in words of 5+ letters).
2. Check numbers SHALL show, per card, "Name matches" or "The name on this card doesn't match the name you entered. We'll check this by hand."
3. A name mismatch on either card SHALL send the account to **Manual review**, even when the numbers match.
4. "Use number from document" SHALL count as a match only when that card's name matches; otherwise the account goes to **Manual review**. This closes the gap where someone else's PAN card could make an account Verified.
