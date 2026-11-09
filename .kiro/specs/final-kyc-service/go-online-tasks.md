# Final KYC: tasks to take it online (later)

Not started. Nothing here runs until Nitish says yes to each step. For now Final KYC is tested only on this laptop (local mode).

## 1. Before anything goes online (Nitish)

| # | Task | Who |
|---|---|---|
| 1 | Compliance adviser signs off the KYC flow | Nitish |
| 2 | NISM Series V-A certificate and AMFI ARN | Nitish |
| 3 | KYC partner contract and sandbox keys (e.g. Digio / FintechPrimitives) | Nitish |
| 4 | Personal AWS account with billing alerts and CLI sign-in | Nitish |
| 5 | Retention period for KYC records (`DOC_RETENTION_DAYS`) | Compliance adviser |
| 6 | Rewrite the 6 consent tick texts (`CONSENT_TEXT` in packages/core) | Compliance adviser |

## 2. Build work still needed

| # | Task |
|---|---|
| 7 | Real partner adapter (replaces FakePartner), tested against the sandbox |
| 8 | Per-IP OTP send limit or a CAPTCHA (a stranger can use up a contact's 10 sends a day) |
| 9 | KRA upload status re-check on `GET /kyc/status` with the real partner |
| 10 | Later: let a user appeal a staff-rejected case (R8) |

## 3. Test server (dev stack on AWS)

| # | Task |
|---|---|
| 11 | `npm run deploy -w @wealthfire/kyc-service` for the dev stack, with `budgetEmail` (only after Nitish's OK) |
| 12 | Set the SNS SMS monthly spend limit; turn on GuardDuty in ap-south-1 |
| 13 | Verify the SES sender email; create the review-console staff users in Cognito |
| 14 | Confirm the Cognito authorizer accepts `Authorization: Bearer <idToken>` |
| 15 | Point the web app at the dev API (`apps\web\.env.local` `VITE_API_URL=`) and run TC-56 to TC-80 |
| 16 | Phone apps: dev build (not Expo Go), test on a real Android and iPhone |

## 4. Before prod

| # | Task |
|---|---|
| 17 | Own app domain (not the shared nitishsana.github.io); set `-c appOrigin=` |
| 18 | Custom API and console domains with certificates (`apiDomain`, `apiCertArn`, `consoleDomain`, `consoleCertArn`) |
| 19 | Turn off the default execute-api URL once the apps use the custom API domain |
| 20 | Prod deploy (separate decision) |

## 5. Release

| # | Task |
|---|---|
| 21 | Push `feature/final-kyc`, open the PR, CI green |
| 22 | Full-flow bug check on web, Android and iOS; list must / should / minor |
| 23 | Merge only with Nitish's yes; add the rows to FEATURES.md |

Full steps for the AWS parts: services/kyc/infra/DEPLOY.md.
