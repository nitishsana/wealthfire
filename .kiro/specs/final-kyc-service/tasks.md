# Tasks: Final KYC service

Spec: `requirements.md`, `design.md` (approved 2026-11-06). Repo `github.com/nitishsana/wealthfire`, new branch from `origin/main` (e.g. `feature/final-kyc`). Workflow per `.kiro/steering/agent-workflow.md`: Chief of Staff starts the agents (sub-agents cannot start their own), separate file ownership, questions go to Nitish, independent review before anything is shown, no push/merge/deploy without Nitish's yes.

Everything in waves 1–4 builds and tests **without** AWS, the partner or the ARN, using `FakePartner` and in-memory adapters. Wave 5 needs Nitish's prerequisites.

## Wave 0 — Setup (Chief of Staff)

- [ ] 1. Branch `feature/final-kyc` from `origin/main`; add `services/kyc` to root `package.json` workspaces; `services/kyc/package.json` (TypeScript 5.9.3, vitest 5.1.0, exact pins), `tsconfig.json`, scripts `test`, `typecheck`, `build` (esbuild bundle per Lambda).
- [ ] 2. CI: add a `services` job to `.github/workflows/ci-and-pages.yml` running `npm ci`, test, typecheck and `cdk synth` (no deploy).
- [ ] 3. Copy this spec to the repo at `.kiro/specs/final-kyc-service/`.

## Wave 1 — Foundations (parallel)

- [ ] 4. **Infra agent** (`services/kyc/infra/**`): CDK app with `dev` and `prod` stacks in `ap-south-1`: HTTP API + WAF rate rule, Lambdas `api` and `webhook`, DynamoDB tables `users`, `sessions`, `otp`, `kyc_cases`, `audit`, `costs` (on-demand, PITR, KMS), S3 docs bucket (block public, SSE-KMS, lifecycle `DOC_RETENTION_DAYS`), KMS keys (data, JWT signing, HMAC), Secrets Manager entries (partner creds, placeholders), Cognito user pool for staff with MFA + `reviewer` group, AWS Budget alarm, least-privilege IAM. `cdk synth` passes; snapshot tests for key resources. (Design §1, §2, §7)
- [ ] 5. **Rules agent** (`services/kyc/src/decide.ts`, `src/match.ts`, tests): pure decision table from design §5; name match reuses `packages/core` rules (exact first name, surname last); DOB match; thresholds from config. 100% branch coverage of the table.
- [ ] 6. **Auth agent** (`services/kyc/src/auth/**`): OTP send/verify (argon2id hash, 5-minute TTL, 5 tries, resend limits, per-target and per-IP limits), JWT access (15 min, KMS-signed) + rotating refresh tokens, logout/revoke; storage via a `Repo` interface with an in-memory implementation for tests and a DynamoDB implementation. SMS/email sender interface with a fake.

## Wave 2 — KYC flow (parallel, after wave 1)

- [ ] 7. **KYC routes agent** (`services/kyc/src/kyc/**`, `src/partner/**`): `KycPartner` interface and `FakePartner` (deterministic scenarios: validated, not-found → full KYC pass, unclear, reject); routes `/kyc/start`, `/kyc/aadhaar`, `/kyc/documents` (presigned S3, 10 MB, JPG/PNG/PDF), `/kyc/esign`, `/kyc/status`; idempotency keys; per-user daily cap on paid checks; `costs` logging. Full Aadhaar never stored; PAN encrypted + HMAC lookup key.
- [ ] 8. **Webhook agent** (`services/kyc/src/webhook/**`): signed partner callbacks (signature check via `KycPartner.verifyWebhook`), replay protection (timestamp + id), updates `kyc_cases` with optimistic version checks, writes `audit`.
- [ ] 9. **Review console agent** (`services/kyc/review-console/**`): static staff web app (Cognito sign-in with MFA), list Under-review cases, case detail (check results, masked values, document preview via short-lived presigned GET), Approve / Reject with reason; `/review/*` routes in the API with `reviewer` group check; every action audited.

## Wave 3 — Apps (parallel, after wave 2 API is stable)

- [ ] 10. **Core agent** (`packages/core/**`): `HttpOtpProvider` and `ServerKycClient` behind the existing slots; server status types; `isEligibleToInvest` reads server status; tests with a fake fetch.
- [ ] 11. **Web agent** (`apps/web/**`): config `VITE_API_URL`; after Check numbers call `/kyc/start` and follow `next` (DigiLocker / e-sign redirects, waiting state); status from server in Settings → Account; refresh token cookie handling; demo providers kept for local preview.
- [ ] 12. **Phone agent** (`packages/mobile-ui/**`, `apps/android/**`, `apps/ios/**`): same as web with `expo.extra.apiUrl`, tokens in `expo-secure-store` (exact pin for Expo 58), DigiLocker / e-sign via `expo-web-browser` auth session.
- [ ] 13. Feature id `kyc-final-status` in `features.ts`, tagged on web and phones; test cases page + artifact rows for the server-backed flows (dev stack).

## Wave 4 — Review and checks

- [ ] 14. Independent reviewer: code vs this spec (all R1–R7).
- [ ] 15. Security reviewer: auth, tokens, IAM, KMS, logs scrubbing (no PAN/Aadhaar/OTP/tokens), CORS, WAF, webhook signing, S3 access, DPDP consent + delete route.
- [ ] 16. All checks: repo tests, typechecks, parity, web build, phone `tsc` + `expo export`, `services` tests + `cdk synth`. Local commits.

## Wave 5 — Needs Nitish (each step waits for his explicit OK)

- [ ] 17. Prerequisites: compliance adviser sign-off, NISM V-A + AMFI ARN, partner contract + sandbox credentials, personal AWS account with billing alerts and CLI login.
- [ ] 18. Write `FintechPrimitivesPartner` (or the chosen partner) against the sandbox docs; sandbox test of every path.
- [ ] 19. Deploy the `dev` stack to Nitish's AWS account (after OK); point the local preview at it; run the test cases.
- [ ] 20. Push, PR, CI, full-flow bug check, merge (after OK). `prod` deploy is a separate, later decision.
- [ ] 21. Before prod (from wave 4 reviews):
  - Dedicated app domain (S5): set `-c appOrigin=` so the shared `nitishsana.github.io` origin is no longer trusted for the cookie, CORS and return URLs. No prod without it.
  - Custom API / console domains with certificates (S13 context values).
  - SNS SMS monthly spend limit set in the account (see services/kyc/infra/DEPLOY.md).
  - GuardDuty on in ap-south-1.
  - Retention period for KYC records set by the compliance adviser (`DOC_RETENTION_DAYS`).
  - Compliance adviser rewrites the consent tick texts (`CONSENT_TEXT` in packages/core).
  - First dev deploy: confirm the Cognito authorizer accepts `Authorization: Bearer <idToken>` from the review console.
  - Turn off the default execute-api URL once the apps use the custom API domain.
  - KRA upload status re-check on `GET /kyc/status` with the real partner (late `kra.upload` webhooks are refused on ref mismatch).

## Later

- [ ] 22. R8: rejected cases are final for now. Later: let a user appeal or restart a staff-rejected case.
