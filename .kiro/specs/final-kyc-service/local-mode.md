# Final KYC: local mode (test the whole flow on this laptop, no AWS)

Approved by Nitish 2026-11-09 ("Use all 3 suggestions and build it"). Online deploy tasks are in go-online-tasks.md and are NOT part of this.

## What Nitish gets

Double-click `CMD files/Wealthfire Preview.cmd`. It starts, on this computer only:

| Part | Address | What |
|---|---|---|
| App (web) | http://127.0.0.1:5180 | Vite, server mode pointed at the local KYC server |
| Local KYC server | http://127.0.0.1:5181 | The real router + KYC service, no AWS |
| Review console | http://127.0.0.1:5182 | Staff console, "Sign in as demo reviewer" |

## Decisions (Nitish)

1. OTP: the code shows on screen as `DEMO code: 123456` under the code box (and in the server window). No SMS or email is sent.
2. Staff sign-in: a "Sign in as demo reviewer" button, no password, local only.
3. Test data is kept in a local folder between runs. A "Reset local data" link (in the test cases) wipes it.

## Contracts

- Stage: env `STAGE=local`. Local-only behaviour runs ONLY when STAGE is exactly `local` AND the server is the local Node entry (not the Lambda handler). The Lambda handler refuses STAGE=local. The local server binds 127.0.0.1 only.
- Server entry: `services/kyc/local/server.ts`, script `npm run local -w @wealthfire/kyc-service` (tsx). Same `createRouter` / KYC service / review routes / webhook / dev partner pages as the Lambda, wired with local adapters:
  - stores: the memory stores, saved to `services/kyc/.local-data/state.json` after every write and loaded at start (folder gitignored);
  - encryption: `LocalEncryptor` with a key generated once into `.local-data/` (purpose context still required);
  - partner: `FakePartner` with links to `http://127.0.0.1:5181/dev-partner/...` (tagged, as on dev) and webhooks posted to the local server;
  - uploads: presigned-style local URLs `PUT http://127.0.0.1:5181/local-files/<key>?exp=..&sig=..` (HMAC over method|key|exp|content-type|length; same headers returned to the app as today, incl. `x-amz-tagging` and `if-none-match`, which the local handler honours: no overwrite, tag stored beside the file); files under `.local-data/files/`; the first-bytes type check reads the local file; downloads for the console via `GET /local-files/<key>?exp&sig&disposition`;
  - OTP sender: `LocalDemoSender` keeps the last code per contact; on STAGE=local only, `POST /auth/otp/send` answers with an extra field `demoCode: "123456"` and the server window prints `DEMO code for ******3210: 123456`;
  - staff auth: on STAGE=local only, the staff verifier accepts exactly `Authorization: Bearer local-demo-reviewer` as reviewer `demo-reviewer` (role reviewer). Anything else is refused as today;
  - env: APP_ORIGINS and allowed origins `http://127.0.0.1:5180,http://127.0.0.1:5182`, RETURN_URL_PREFIXES `http://127.0.0.1:5180/,wealthfire://kyc-return`, API_BASE_URL `http://127.0.0.1:5181/`.
- Reset: `GET http://127.0.0.1:5181/local/reset` shows a page with one "Reset local data" button; `POST /local/reset` wipes `.local-data/` state and files (keeps the key), then shows "Local data cleared.". STAGE=local only.
- The review console is served by the local server on 127.0.0.1:5182 from its built `dist`, with a local config (API `http://127.0.0.1:5181`, `localDemo: true`). With `localDemo`, the console shows "Sign in as demo reviewer" instead of Cognito and sends `Bearer local-demo-reviewer`.
- Web: Vite mode `localkyc` with committed `apps/web/.env.localkyc`: `VITE_API_URL=http://127.0.0.1:5181`, `VITE_KYC_REDIRECT_ORIGINS=http://127.0.0.1:5181`. When the OTP send answer has `demoCode`, the sign-in screen shows `DEMO code: <code>` under the code box (core client exposes it). Phones are out of scope for local mode.
- Cookie: the web refresh cookie must work on http://127.0.0.1 (Edge treats loopback as secure). If the browser blocks it, the app falls back to 'Please sign in again.' as today.
- Launcher: `Wealthfire Preview.cmd` starts the local server (5181, which also serves the console on 5182) and Vite in `localkyc` mode (5180), waits for both, opens the test cases and the app. Still the only launcher. Same-named shortcut copy in the OneDrive `CMD files` folder.
- Test cases: TC-56..80 say "needs the local KYC server (starts with the preview)" instead of "needs the dev API"; setup lines updated; links to the console and the Reset page.

## Local test home (Nitish, 2026-11-09)

One launcher (`Wealthfire Preview.cmd`) opens one home page to sign in as different users of the three local apps.

- Where: `GET http://127.0.0.1:5181/` on the local KYC server (STAGE=local only). Not a file in `CMD files/` (that folder keeps exactly two files). The launcher opens the home page (and the test cases page) instead of the bare app.
- Test users: one shared list `LOCAL_PERSONAS` in `packages/core` (the server imports it, so home page and app agree). Each has: id, display name, what it tests (one line), a distinct mobile, first/last name, PAN, date of birth, Aadhaar last 4. Cover at least: KYC record found (fast path to Verified), no KYC record (DigiLocker + selfie + e-sign), hand check by staff, PAN already used by another user, partner slow (Try again), under 18. Values must drive the FakePartner to that outcome (read `services/kyc/src/partner/fake.ts`).
- App sign-in: each user's button opens `http://127.0.0.1:5180/?persona=<id>`. Only in the `localkyc` build, the app then (a) keeps that user's data in its own browser storage space (keys prefixed by persona id), so users never mix; (b) prefills the mobile and, after Send OTP, the DEMO code, so one click on Verify signs in; (c) prefills Your details. A small 'Test user: <name> · Switch user' bar links back to the home page. Unknown persona id -> normal app.
- Demo mode without the server: `http://127.0.0.1:5180/?server=off` (localkyc build only) runs the app with no server, for the demo-mode test cases. No terminal commands for Nitish.
- Staff: a 'Sign in as demo reviewer' button opening `http://127.0.0.1:5182/`.
- Server: 'Reset local data' (the existing reset page), a status line for each of 5180 / 5181 / 5182 (up / not running), and the latest DEMO codes per masked contact.
- Accessible: real buttons/links, headings, keyboard focus, theme-neutral colours with text labels.
