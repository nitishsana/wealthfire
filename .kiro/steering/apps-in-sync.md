---
inclusion: always
---

# Keep all Wealthfire apps in sync

Wealthfire is several apps that talk to each other (see "The apps and what each is for" in `FEATURES.md`):

- Wealthfire app: web, Android, iOS (`apps/*`, `packages/core`, `packages/mobile-ui`)
- KYC server (`services/kyc`), online and local (`npm run local`)
- Review console (`services/kyc/review-console`)
- Local test home (served by the local KYC server at http://127.0.0.1:5181/)
- Launcher and test cases (`CMD files/`)

## Rule

Any change to one app is finished only when every other app it touches is updated in the SAME commit set:

1. Server route, body, error code or status field changed -> update the core client (`packages/core/src/server.ts`), the web and phone screens, and the review console if staff see it.
2. App flow changed -> the KYC server still accepts it; web, Android and iOS stay the same (`npm run parity`).
3. Console changed -> the server's review routes and staff auth match, both the online build and `build.mjs --local`.
4. Anything a tester needs to see changed (new user type, step, message, port, data folder) -> update the local test home (test users and links), `CMD files/Wealthfire Preview.cmd` and `CMD files/Wealthfire Test Cases.html`, plus the Kiro artifact `wealthfire-test-cases` and the OneDrive `CMD files` copy.
5. Local mode and online mode stay the same flow. Local-only shortcuts (DEMO code, demo reviewer, reset, test users) run only when `STAGE=local` on the laptop and never online.
6. Update `FEATURES.md` ("The apps" table when an app's job changes; feature rows when merged) and `.kiro/specs/final-kyc-service/go-online-tasks.md` when online work is added.

## Before handing back

Run every check: `npm test`, `npm run typecheck`, `npm run parity`, `npm run build`, `npm run test -w @wealthfire/kyc-service`, `npm run typecheck -w @wealthfire/kyc-service`, `npm run synth -w @wealthfire/kyc-service`, `node services/kyc/review-console/build.mjs` (and `--local`), and `npx tsc --noEmit` in `apps/android` and `apps/ios`. A change that leaves one app out of step is not done.
