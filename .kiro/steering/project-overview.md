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
