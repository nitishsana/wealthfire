---
inclusion: always
---

# Wealthfire project overview

Mutual fund + FIRE planner for India. Web, Android and iOS must stay consistent.

- Repo: https://github.com/nitishsana/wealthfire
- Live site: https://nitishsana.github.io/wealthfire/

## Layout

| Path | Job |
|---|---|
| `packages/core` | All money math and data rules, with tests. The only place logic lives. |
| `packages/mobile-ui` | React Native screens shared by both phone apps |
| `apps/web` | React + Vite website |
| `apps/android` | Expo shell for Android |
| `apps/ios` | Expo shell for iPhone |
| `scripts/check-parity.mjs` | Fails if a platform misses a feature or colors differ |

## Adding a feature

1. Add its id to `packages/core/src/features.ts`.
2. Put logic in `packages/core` and add tests in `packages/core/test`.
3. Web page/section gets `data-feature="<id>"`; mobile screen gets `feature="<id>"` or a section with `testID="feature-<id>"`.
4. Keep wording the same on web and mobile.

## Checks before any commit

```
npm test
npm run typecheck
npm run parity
npm run build
cd apps/android && npx tsc --noEmit && npx expo export --platform android
cd apps/ios && npx tsc --noEmit && npx expo export --platform ios
```

## Notes

- Data stays on the device only. No server.
- Gmail uses read-only scope; the token is kept in memory only. Client IDs: web via repo variable `GOOGLE_WEB_CLIENT_ID`, phones via `expo.extra` in each `app.json`.
- Educational estimates only, not investment advice. Keep the disclaimer.
- Onboarding gates the app: sign in → contact OTP → Your details → Aadhaar OTP (once) → Upload documents → Check numbers + names → status. OTPs go through `OtpProvider` (v1 demo); documents through `DocumentReader` (default on-device: Tesseract.js + pdf.js on web, ML Kit + PDF thumbnail on phones; demo reader only in DEV via `?reader=demo&mode=…`).
- The full Aadhaar, documents and OCR text are never stored, logged or put in the backup; only the Aadhaar last 4 is kept.
- Device checks can only give **Pre-verified** (or Under review). **Verified** and `isEligibleToInvest` come only from a final KYC approval (future server-side partner such as Digio + KRA/CKYC, or a human). The Demo reviewer that simulates it renders only in DEV / `__DEV__`.
- Phone apps use native modules, so they need a development build (`npm run android` / `npm run ios`, or EAS `build:apk`); Expo Go opens the app but cannot read documents. CI's `expo export` is JS-only and unaffected.
- Web OCR assets are self-hosted: `scripts/copy-ocr-assets.mjs` runs on `prebuild`/`predev` and copies them into `apps/web/public/ocr/` (git-ignored). No CDN.
