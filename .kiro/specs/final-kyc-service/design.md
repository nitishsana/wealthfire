# Design: Final KYC service

Implements `requirements.md` with the decisions Nitish picked on 2026-11-06:

- **D1 Regulatory route:** Wealthfire gets an AMFI mutual fund distributor registration (ARN) and uses an infra partner (Cybrilla Fintech Primitives is the reference) for KRA lookup/upload and later MF orders.
- **D2 KYC checks:** the partner's own KYC APIs (Aadhaar via DigiLocker / OTP, PAN, face match + liveness, e-sign, KRA upload).
- **D3 Hosting:** AWS, Mumbai region `ap-south-1`, serverless, on **Nitish's own AWS account** (not a work account).

The partner's exact endpoints are only available after signing up and getting sandbox access, so the server talks to it through one adapter interface (`KycPartner`, §4). Everything else in this design does not depend on the partner's wire format.

## 1. Overview

```
Phone / web app ──HTTPS──► API Gateway (HTTP API) ──► Lambda "api"
                                                      │   ├─ auth (OTP)          ─► SMS/email OTP (SNS / SES)
                                                      │   ├─ kyc (start, status) ─► KycPartner adapter ─► Partner sandbox/live
                                                      │   └─ review (staff)      
                                                      ▼
                                     DynamoDB (users, sessions, kyc_cases, audit)   S3 (documents, KMS-encrypted, lifecycle delete)
Partner ──webhook──► API Gateway ──► Lambda "webhook" (signature check) ──► updates kyc_cases
Staff ──► Review console (static site, Cognito + MFA) ──► Lambda "api" /review routes
```

- One repo folder `services/kyc` (TypeScript, Node 22 Lambda), deployed with **AWS CDK** (`services/kyc/infra`).
- Shared rules stay in `packages/core` (status names, masks, validators); the server imports them so app and server never disagree.
- Environments: `dev` (partner sandbox, no real money) and `prod`. Separate stacks, separate secrets.

## 2. Data model (DynamoDB, on-demand, KMS-encrypted)

| Table | Key | Main fields |
|---|---|---|
| `users` | `userId` | contact kind + value (hashed for lookup, encrypted value), createdAt, firstName, lastName, panHash, panLast4, aadhaarLast4 |
| `sessions` | `refreshTokenHash` | userId, device, expiresAt (TTL) |
| `otp` | `challengeId` | target hash, codeHash (argon2id), expiresAt (TTL 5 min), tries, sends |
| `kyc_cases` | `userId` | status (`pre-verified`, `under-review`, `verified`, `rejected`), path (`kra-validated` / `full-kyc` / `hand-check`), partner refs, check results (pass / fail / unclear per check), reason, updatedAt, version |
| `audit` | `userId#ts` | actor (system / staff id), action, before → after, ip |
| `costs` | `yyyy-mm#checkId` | check type, cost ₹, userId |

- Full PAN is stored **encrypted** (KMS data key per record) because the KRA needs it; the lookup key is a keyed hash (HMAC-SHA256 with a KMS-held key).
- **Full Aadhaar is never stored.** Only the partner's reference ID and the last 4.
- S3 bucket `wealthfire-kyc-docs-<env>`: block public access, SSE-KMS, versioning off, object lock off, lifecycle rule deletes documents after the retention period set by the compliance adviser (placeholder setting `DOC_RETENTION_DAYS`).

## 3. API (all JSON, HTTPS, Mumbai)

| Route | Who | Purpose |
|---|---|---|
| `POST /auth/otp/send` | public | send contact OTP (rate-limited per target and IP) |
| `POST /auth/otp/verify` | public | verify; returns access token (15 min JWT) + refresh token |
| `POST /auth/refresh`, `POST /auth/logout` | user | rotate / revoke |
| `POST /kyc/start` | user | body: names, PAN, device result (pre-verified / under-review + masks); runs R2 fast path |
| `POST /kyc/aadhaar` | user | starts DigiLocker consent (returns partner redirect URL) or Aadhaar OTP |
| `POST /kyc/documents` | user | presigned S3 upload URLs for selfie / Aadhaar / PAN (10 MB, JPG/PNG/PDF) |
| `POST /kyc/esign` | user | starts partner e-sign; returns redirect URL |
| `GET /kyc/status` | user | current status, reason, next step; app shows it |
| `POST /webhooks/partner` | partner | signed callbacks (KYC result, e-sign done, KRA upload status) |
| `GET /review/cases`, `POST /review/cases/{id}` | staff | list Under-review cases; Approve / Reject with reason |

- Auth: JWT signed with an asymmetric key in KMS; staff routes require a Cognito token with group `reviewer` and MFA.
- Rate limits: API Gateway throttling + per-user counters in DynamoDB; paid checks capped per user per day (R7).
- Idempotency key header on every POST that triggers a paid check.

## 4. KycPartner adapter (`services/kyc/src/partner/`)

```ts
export interface KycPartner {
  lookupKyc(pan: string): Promise<{ status: 'validated' | 'registered' | 'on-hold' | 'not-found'; name?: string; dob?: string; ref: string }>;
  startAadhaar(userId: string, mode: 'digilocker' | 'otp', returnUrl: string): Promise<{ redirectUrl?: string; challengeRef?: string }>;
  verifyPan(pan: string, name: string): Promise<{ valid: boolean; nameMatch: boolean; aadhaarLinked: boolean }>;
  faceMatch(selfieKey: string, aadhaarRef: string): Promise<{ match: number; live: boolean }>;
  startEsign(userId: string, returnUrl: string): Promise<{ redirectUrl: string; ref: string }>;
  uploadToKra(userId: string): Promise<{ ref: string }>;
  verifyWebhook(headers: Record<string, string>, body: string): boolean;
}
```

- `FakePartner` (deterministic, no network) for tests and the `dev` stack before sandbox access; `FintechPrimitivesPartner` written once the sandbox docs are available.
- Partner credentials live in **Secrets Manager**; only the Lambda role can read them.

## 5. Decision rules (`services/kyc/src/decide.ts`, pure, unit-tested)

| Inputs | Result |
|---|---|
| KRA `validated` AND KRA name matches typed name (same rules as `nameOnCard`, exact first name, surname last) AND DOB matches | **verified** (path `kra-validated`) |
| Full KYC: Aadhaar verified (DigiLocker/OTP) AND PAN valid + name match + Aadhaar-linked AND face match ≥ threshold AND live AND e-sign done | **verified** (path `full-kyc`), then KRA upload |
| Any check `unclear` (low face score, name partial, partner timeout after retries), or device result was a hand check | **under-review** |
| PAN invalid / not individual, Aadhaar mismatch with the OTP-verified last 4, liveness failed twice | **rejected** with reason |
| Staff Approve / Reject | **verified** / **rejected** (audited) |

Thresholds (face match score etc.) are config values set from the partner's guidance.

## 6. App changes (`packages/core`, `apps/web`, `packages/mobile-ui`)

- New `HttpOtpProvider` and `ServerKycClient` behind the existing slots; config `VITE_API_URL` / `expo.extra.apiUrl`. Demo providers stay for local preview.
- After the device Check numbers step, the app calls `POST /kyc/start`, then follows `next` from `GET /kyc/status` (DigiLocker redirect, e-sign redirect, or wait).
- Status shown from the server; the device value is a cache. `isEligibleToInvest` reads the server value.
- Tokens: phones in `expo-secure-store`; web refresh token in an httpOnly, Secure, SameSite=Strict cookie on the API domain.

## 7. Security and privacy

- TLS everywhere; HSTS on the API domain; CORS only for `https://nitishsana.github.io` and the local preview origin in `dev`.
- KMS keys per environment; least-privilege IAM per Lambda; no secrets in the apps or repo.
- Logs (CloudWatch) never contain PAN, Aadhaar, OTPs, tokens or document contents; a log scrubber test enforces it.
- WAF on API Gateway with rate rules; GuardDuty on the account.
- DPDP: consent records per check, a "delete my KYC data" route that deletes what the rules allow and records why the rest is kept.
- Backups: DynamoDB point-in-time recovery on; S3 documents excluded from backups.

## 8. Cost (rough, to confirm with partner pricing)

- AWS serverless at low volume: a few hundred rupees a month (Lambda, API Gateway, DynamoDB on-demand, S3, KMS keys ~US$1 each/month).
- Partner checks: per-check fees (public market prices are roughly ₹1–₹10 per check); the `costs` table and a monthly AWS Budget alarm track spend.

## 9. Testing

- Unit: `decide.ts` table, name/DOB matching, OTP rules, token rotation, webhook signature, log scrubber.
- Integration: `FakePartner` end to end through API Gateway locally (`sam local` or CDK + LocalStack is not needed; Lambda handlers tested with an in-memory DynamoDB adapter).
- Sandbox: partner sandbox run of all paths (validated, full KYC pass, unclear → review, reject).
- App: new rows in `CMD files/Wealthfire Test Cases.html` for server-backed flows (dev stack URL).

## 10. Prerequisites outside the code (Nitish)

1. Compliance adviser confirms the route (ARN, partner contract, retention periods).
2. AMFI ARN registration (NISM Series V-A certification is needed first).
3. Partner sign-up and sandbox credentials.
4. Personal AWS account, with billing alerts, and `aws sso login` / `aws configure` on this laptop.
5. Domain for the API (optional; API Gateway's default URL works for `dev`).

## 11. Build plan (for tasks.md)

Chief of Staff starts these after design approval (sub-agents cannot start their own):

| Wave | Agents (parallel) | Owns |
|---|---|---|
| 1 | Infra (CDK stacks, tables, bucket, KMS, secrets, budgets) · Core rules (decide.ts, matching, masks shared with `packages/core`) · Auth (OTP, tokens) | `services/kyc/infra`, `services/kyc/src/decide*`, `services/kyc/src/auth` |
| 2 | KYC routes + FakePartner · Webhooks · Review console | `services/kyc/src/kyc`, `src/webhook`, `services/kyc/review-console` |
| 3 | App: web client · App: phone client | `apps/web`, `packages/mobile-ui` |
| 4 | Independent reviewer + security reviewer; checks; `dev` deploy (only after Nitish's AWS setup and OK) | — |

Deploying anything to AWS is a separate step that needs Nitish's explicit OK each time.
