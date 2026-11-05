# 🔥 Wealthfire

A mutual fund and FIRE (Financial Independence, Retire Early) planner for India.
It runs on the web, Android and iPhone, and gives the same answers on all three.

**Live website:** https://nitishsana.github.io/wealthfire/

## What it does (v0.1)

| Feature | What it does |
|---|---|
| Profile | Name, age, city, income, current SIP, target retire age |
| Risk score | 6 questions plus your age give a score from 0 to 100 and a profile (Conservative to Aggressive) |
| Net worth | Assets and liabilities, EMIs, investable corpus |
| Expenses | Upload or paste a credit card statement (CSV/text). Spends are sorted into categories automatically |
| FIRE plan | FIRE number, projected corpus, SIP needed (with yearly step-up), earliest FIRE age |
| Portfolio | Mutual fund categories and SIP split based on risk. Equity is capped as FIRE gets closer |
| Buckets | 3-bucket plan: Spend / Refill / Grow, with move tips that change over time and with the market |
| Progress | Monthly check-ins compared against the plan (ahead / on plan / behind) |
| Connect | Gmail, Account Aggregator, CAS, broker and EPF links (coming soon) |
| Settings | Assumptions, demo data, backup, delete |

Data is stored only on the device (browser localStorage / phone AsyncStorage). There is no server.

## Layout

```
packages/core       Shared logic (TypeScript, no UI). The only place money math lives.
packages/mobile-ui  React Native screens shared by both phone apps.
apps/web            React + Vite website (GitHub Pages).
apps/android        Expo app shell for Android (back button, package id, permissions).
apps/ios            Expo app shell for iPhone (bundle id, iOS settings).
scripts/check-parity.mjs  Fails CI if a platform is missing a feature or themes drift.
```

## Keeping all platforms the same

1. Add the feature id to `packages/core/src/features.ts`.
2. Put any logic in `packages/core` and add a test in `packages/core/test`.
3. Build the web page with `data-feature="<id>"` and the mobile screen with `feature="<id>"`.
4. Run `npm run parity`. CI runs it on every push.

Colors live in `apps/web/src/styles.css` and `packages/mobile-ui/src/theme.ts`; the parity check makes sure they match.

## Run it

```bash
# Website + core
npm install
npm test            # core tests
npm run dev         # http://127.0.0.1:5173
npm run build

# Android (needs the Expo Go app on your phone, or an emulator)
cd apps/android && npm install && npx expo start

# iPhone (Expo Go on iPhone; building an .ipa needs an Apple developer account)
cd apps/ios && npm install && npx expo start
```

## Not advice

Wealthfire gives educational estimates. Mutual fund investments are subject to market risks.
Talk to a SEBI-registered investment adviser before you invest.
