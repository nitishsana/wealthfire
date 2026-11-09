# Requirements: Final KYC service (draft for review)

## Introduction

Wealthfire onboarding (PR #7, #9) ends with **Pre-verified** or **Under review**. Device checks cannot prove identity, so **Verified** — and `isEligibleToInvest` — must come from a final KYC done on a server with regulated sources. This service turns Pre-verified / Under review into Verified, Under review (hand check) or Rejected, and is the gate the later investment journey relies on.

### Facts that shape the design (researched 2026-11-06)

- KYC records for mutual fund investors live with SEBI-registered **KYC Registration Agencies (KRAs)** such as CAMS KRA and NDML KRA. KRAs give access to **SEBI-registered intermediaries** (mutual funds, distributors' platforms, RTAs). An unregistered app cannot query or upload to a KRA on its own. Sources: [NDML KRA](https://www.ndml.in/kra.php), [Bajaj AMC on CAMS KRA](https://www.bajajamc.com/knowledge-centre/guide-to-cams-kra).
- SEBI also lets an intermediary rely on KYC already done through a KRA or **CKYCRR**, but accountability stays with the intermediary. Source: [TaxGuru on SEBI digital KYC](https://taxguru.in/sebi/sebi-digital-kyc-nris-ocis-foreign-nationals-3-december-2026-intermediary-controls.html).
- Fintechs usually reach KRAs and mutual fund order systems through an infrastructure partner, e.g. Cybrilla **Fintech Primitives** (KYC, MF orders, payments APIs; Cybrilla holds a SEBI RTA licence). Sources: [Fintech Primitives](https://fintechprimitives.com/), [Mint on Cybrilla](https://www.livemint.com/money/personal-finance/fintechs-ondc-low-cost-mutual-fund-sip/amp-11749357156085.html).
- Separate identity vendors (Digio, HyperVerge, Cashfree Secure ID, etc.) offer DigiLocker Aadhaar fetch, PAN verification, OCR and face liveness, priced per check (roughly ₹1–₹10 per verification on public price lists). Sources: [Cashfree DigiLocker](https://www.cashfree.com/docs/secure-id/digilocker/digilocker), [eKYCNow pricing](https://messagecentral.com/product/ekyc-now/pricing/india).

Content was rephrased for compliance with licensing restrictions. This is a technical plan, not legal advice; the regulatory route must be confirmed with a SEBI/AMFI compliance adviser.

### Open decisions (see chat)

- **D1 – Regulatory route:** register as an AMFI mutual fund distributor (ARN) and use an infra partner for KRA + orders; or white-label a partner end to end; or stay a planner only (no investing, no final KYC).
- **D2 – KYC vendor:** use the infra partner's own KYC APIs, or a separate identity vendor (Digio / HyperVerge) plus the partner for KRA.
- **D3 – Hosting:** AWS in Mumbai (`ap-south-1`) — Lambda + API Gateway + DynamoDB + S3 + KMS; or another cloud.

## Glossary

| Term | Meaning |
|---|---|
| KRA | SEBI-registered KYC Registration Agency (CAMS KRA, NDML, CVL, Karvy, DotEx) |
| CKYCRR | Central KYC Records Registry (CERSAI) |
| KYC status | KRA result for a PAN: e.g. KYC Validated / Registered / On hold / Not found |
| Infra partner | Regulated provider that gives API access to KRA and MF orders (e.g. Fintech Primitives) |
| Final KYC | The server-side decision that sets Verified, Under review or Rejected |

## Requirements

### R1. Real accounts and real OTP

1. The app SHALL create a server account at sign-in; the contact OTP and Aadhaar OTP SHALL come from real providers (SMS/email OTP; Aadhaar via the KYC vendor / DigiLocker), replacing the demo providers behind the existing `OtpProvider` slot.
2. The server SHALL issue a session token (short-lived access + refresh); the app SHALL keep it in secure storage (Keychain / Android Keystore; web: httpOnly cookie).
3. Existing device-only data SHALL keep working; nothing financial is uploaded unless a later feature asks.

### R2. KYC lookup by PAN (fast path)

1. WHEN onboarding reaches Pre-verified or Under review THEN the server SHALL query the investor's KYC status by PAN (through the infra partner).
2. WHEN the KRA status is Validated and the KRA name and date of birth match the onboarding details THEN the account SHALL become **Verified** without asking for documents again.
3. WHEN the status is Registered / On hold / Not found THEN the flow SHALL continue to R3.

### R3. New or updated KYC (full path)

1. The server SHALL verify Aadhaar through a regulated route (DigiLocker consent or Aadhaar OTP eKYC), verify PAN with the Income Tax database (name + status + PAN–Aadhaar link), and run face match + liveness between the selfie and the Aadhaar photo.
2. The investor SHALL e-sign the KYC form (Aadhaar e-sign), and the record SHALL be uploaded to the KRA through the partner.
3. WHEN all checks pass THEN status SHALL become **Verified**; WHEN any check is unclear THEN **Under review**; WHEN a check clearly fails THEN **Rejected** with a reason.

### R4. Human review

1. Under-review cases SHALL appear in a staff-only review console (separate web app, staff sign-in with MFA), showing check results and documents with an audit trail.
2. A reviewer SHALL Approve (→ Verified) or Reject with a reason (→ Rejected); every action SHALL be logged with who and when.
3. The device's Demo reviewer stays dev-only.

### R5. Status back to the app

1. The app SHALL fetch the status from the server on launch and on Settings → Account; the server value SHALL override any device value.
2. `isEligibleToInvest` SHALL be decided on the server; the app's copy is display only.
3. The app SHALL show the existing texts for Pre-verified, Under review, Verified and Rejected.

### R6. Data protection

1. All KYC data SHALL stay in India (Mumbai region), encrypted at rest (KMS) and in transit (TLS 1.2+).
2. Full Aadhaar numbers SHALL never be stored (Aadhaar Act); only reference IDs / masked values. Documents SHALL be kept only as long as the KRA/SEBI rules require, then deleted.
3. Consent SHALL be recorded for each check (DigiLocker, Aadhaar, KRA upload) under the DPDP Act, with an option to withdraw.
4. Vendor and partner secrets SHALL live only on the server (Secrets Manager), never in the apps.

### R7. Cost and limits

1. Each paid check SHALL be logged with its cost; a monthly budget alarm SHALL fire at a set amount.
2. Retries per investor SHALL be capped to avoid runaway vendor costs.

## Out of scope

- Placing mutual fund orders, mandates and payments (the later investment journey).
- NRI / non-individual KYC.
