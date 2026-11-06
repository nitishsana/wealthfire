# Wealthfire feature log

Only features that are merged into `main` are listed here.
Each row is: Date (merge date, IST) · Category (app section) · Feature description.
Features apply to web, Android and iOS unless the row says otherwise.

Last updated: 2026-11-06 (PR #4)

## Platform (all apps)

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Platform | One shared core (`packages/core`) runs all money math for web, Android and iOS (PR #1) |
| 2026-11-06 | Platform | Website built with React + Vite, auto-deployed to GitHub Pages (PR #1) |
| 2026-11-06 | Platform | Android and iPhone apps built with Expo, sharing one set of screens (PR #1) |
| 2026-11-06 | Platform | Parity check fails CI if any platform is missing a feature or colors differ (PR #1) |
| 2026-11-06 | Platform | All data stays on the device (browser storage / phone storage); no server (PR #1) |
| 2026-11-06 | Platform | Not-advice disclaimer on every page (PR #1) |

## Home

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Home | Summary tiles: net worth, monthly spend, risk profile, FIRE status (PR #1) |
| 2026-11-06 | Home | FIRE progress bar, monthly SIP now vs needed, bucket tips, progress tips (PR #1) |
| 2026-11-06 | Home | "A few steps left" card links to missing profile, risk quiz or expenses (PR #1) |
| 2026-11-06 | Home | Switch FIRE type in place; status tile and progress card name the chosen type (PR #4) |
| 2026-11-06 | Home | FIRE types comparison table and Coast FIRE milestone bar (PR #4) |

## Profile

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Profile | Name, age, city, dependents, take-home pay, current SIP, retire age, plan-till age (PR #1) |
| 2026-11-06 | Profile | Option to type monthly spend instead of using expenses (PR #1) |
| 2026-11-06 | Profile | Pick FIRE goal: Lean, FIRE, Barista or Fat (PR #4) |
| 2026-11-06 | Profile | Part-time income box for Barista FIRE (default 40% of spend) (PR #4) |

## Risk

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Risk | 6-question quiz plus age adjustment gives a score of 0–100 (PR #1) |
| 2026-11-06 | Risk | Profiles: Conservative, Moderate, Balanced, Growth, Aggressive (PR #1) |

## Net worth

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Net worth | Add and remove assets by type (equity MF, debt MF, stocks, FD, EPF, PPF, NPS, gold, cash, property) (PR #1) |
| 2026-11-06 | Net worth | Add and remove loans with amount owed, EMI and interest rate (PR #1) |
| 2026-11-06 | Net worth | Net worth, investable corpus, total EMIs, asset mix chart (PR #1) |

## Expenses

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Expenses | Upload or paste a credit card statement (CSV/text); refunds and payments skipped (PR #1) |
| 2026-11-06 | Expenses | Spends sorted into categories automatically from the shop name (PR #1) |
| 2026-11-06 | Expenses | Add a spend by hand; change any category; monthly spend by category chart (PR #1) |
| 2026-11-06 | Expenses | Connect Gmail (read-only) to read card spend alert emails into expenses (PR #2) |
| 2026-11-06 | Expenses | Gmail skips refunds, OTPs, payments and declines; never adds the same spend twice (PR #2) |
| 2026-11-06 | Expenses | Gmail connect moved into Expenses as a card (no separate tab); later syncs read only new mail (PR #3) |

## FIRE plan

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | FIRE plan | FIRE number, projected corpus, SIP needed with yearly step-up, earliest FIRE age (PR #1) |
| 2026-11-06 | FIRE plan | Retire-age slider and corpus vs target chart (PR #1) |
| 2026-11-06 | FIRE plan | FIRE types: Lean (70% of spend), FIRE (100%), Barista (spend minus part-time income), Fat (150%) (PR #4) |
| 2026-11-06 | FIRE plan | Side-by-side comparison of all FIRE types: corpus per month, FIRE number, SIP, FIRE age (PR #4) |
| 2026-11-06 | FIRE plan | Coast FIRE milestone: amount needed today to coast to FIRE by 60 (PR #4) |
| 2026-11-06 | FIRE plan | "Which FIRE fits you?" guide explaining each type (PR #4) |

## Portfolio

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Portfolio | Mutual fund category mix by risk profile, with SIP split per fund type (PR #1) |
| 2026-11-06 | Portfolio | Equity capped as FIRE gets close (glide path) (PR #1) |
| 2026-11-06 | Portfolio | SIP sized for the chosen FIRE type (PR #4) |

## Buckets

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Buckets | 3 buckets: Spend (cash), Refill (debt/gold), Grow (equity), with targets and fill bars (PR #1) |
| 2026-11-06 | Buckets | Phase tracker and timed move tips that react to good and bad market years (PR #1) |
| 2026-11-06 | Buckets | Buckets sized for the chosen FIRE type's spending (PR #4) |

## Progress

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Progress | Monthly check-ins; ahead / on plan / behind verdict vs plan; history table (PR #1) |

## Connect

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Connect | Placeholders for bank (Account Aggregator), mutual fund CAS, brokers, EPF/NPS (PR #1) |
| 2026-11-06 | Connect | Gmail card points to Expenses (PR #3) |

## Settings

| Date | Category | Feature Description |
|---|---|---|
| 2026-11-06 | Settings | Edit assumptions: inflation, returns, safe withdrawal rate, SIP step-up (PR #1) |
| 2026-11-06 | Settings | Load demo data, download backup, delete all data (PR #1) |
