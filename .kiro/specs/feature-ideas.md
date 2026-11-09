# Feature ideas (not started)

Ideas Nitish wants built later. Nothing here is built until:

1. the current work (final KYC, local test mode, test fixes on `feature/final-kyc`, PR #10) is fixed, retested and merged into `main`;
2. Nitish approves a spec (requirements, design, tasks) for the idea.

Each idea follows the usual flow then: spec, Chief of Staff and builders, an independent reviewer, independent testers, and Nitish's yes before the merge.

---

## Idea 1: Retirement bucket simulator (3-bucket withdrawal engine)

Added 2026-11-09 by Nitish. Status: **idea, waiting**.

It builds on the existing **Buckets** page (3 pots with time- and market-based move tips; see FEATURES.md, "Buckets"). The spec must decide whether it replaces that page or extends it.

### System inputs and variables (user dashboard)

| Input | Meaning |
|---|---|
| Total retirement corpus | The starting lump sum available for investment |
| Initial annual expense | Projected living expenses for the first year |
| Inflation rate | Yearly % increase in living expenses (e.g. 6%) |
| Expected returns | A separate expected yearly growth rate per bucket (e.g. Liquid 6%, Debt 8%, Equity 12%) |

### Rule 1: Portfolio set-up (the 3 buckets)

- **Bucket 1 (Liquid paycheck):** the first 2 to 3 years of living expenses. Ultra-safe, liquid instruments, e.g. arbitrage funds or high-yield bank deposits.
- **Bucket 2 (Shock absorber):** the next 5 years of living expenses. Short-term debt funds or hybrid funds with low equity.
- **Bucket 3 (Growth engine):** all of the remaining corpus. Pure equity funds for long-term growth and inflation protection.

### Rule 2: Yearly withdrawal and growth

- **Withdrawal:** take the whole year's expense from Bucket 1.
- **Growth:** at year end, apply each bucket's expected return to what is left in Buckets 1, 2 and 3.
- **Inflation:** raise next year's expense by the inflation rate.

### Rule 3: Refill engine (rebalancing)

- **Bucket 1 top-up:** move money from Bucket 2 to Bucket 1, back to its target (2 to 3 years of the *new*, inflation-adjusted expense).
- **Bucket 2 top-up:** move money from Bucket 3 to Bucket 2, back to its target (5 years of the *new*, inflation-adjusted expense).
- **In short:** Bucket 1 pays the bills, Bucket 2 refills Bucket 1, Bucket 3 refills Bucket 2.

### Rule 4: Market crash protection (sequence-of-returns risk)

- **Valuation check:** if Bucket 3 (equity) has a sharp crash or a negative-return year, **pause** the Bucket 3 to Bucket 2 transfer.
- **Stress mode:** keep paying expenses from Bucket 1, and keep refilling Bucket 1 from Bucket 2.
- **Recovery trigger:** leave Bucket 3 untouched so equity can recover (historically about 2.3 to 6.4 years). Once Bucket 3 has recovered its value, resume the normal refill of Bucket 2.

### Questions to settle in the spec (ask Nitish then, not now)

- Bucket 1 target: 2 or 3 years by default, and can the user choose?
- What counts as a "sharp crash": any negative year, or a drop beyond a set % (e.g. 10% or 20%)?
- What counts as "recovered": back to the pre-crash value in money terms, or including the missed growth?
- The simulation horizon (e.g. to age 90 or 100), and what the dashboard shows when a bucket runs dry (the year the money runs out).
- Fixed returns only, or also a "bad years" or historical-returns scenario to show the crash rule working?
- Taxes, exit loads and fund costs: ignore for v1 or include?
- Show results as a year-by-year table, a chart, or both, on web, Android and iOS.

---

## Idea 2: Risk profile right after KYC, inside Profile, and locked identity

Added 2026-11-09 by Nitish. Status: **idea, waiting**.

### What Nitish wants

1. **Risk profile straight after KYC (mandatory).** As soon as KYC is completed, show the risk profile questions as cards, so every question gets answered. Answering all of them is mandatory before any investing happens.
2. **Risk moves into Profile.** The separate Risk tab goes away. Risk profile becomes a section inside the Profile tab.
3. **Toggle (collapsed by default).** Inside Profile, the risk profile section is always collapsed. Clicking it expands it; clicking again collapses it.
4. **Name and age locked after KYC.** Once KYC is completed, Profile shows the name and age as read-only. They can never be edited after that.

### Links to what exists today

- Risk today: its own tab, 6 questions plus age, a score out of 100, five profiles (FEATURES.md, "Risk"). Since PR #10 there is no score until all 6 questions are answered.
- KYC today: the device check gives Pre-verified; Verified comes only from final KYC on the KYC server. Investing requires Verified (`isEligibleToInvest`).
- Profile today: name and age are editable fields; the name also comes from onboarding ("Your details").

### Questions to settle in the spec (ask Nitish then, not now)

- Which "KYC completed" starts the cards: the end of onboarding (Pre-verified or Under review), or final KYC Verified? (The note says "KYA"; this is read as KYC.)
- Can the user skip the cards and use the planner meanwhile, with only investing blocked? Or must they finish the cards before anything else?
- One question per card with Next/Back, or all cards on one screen? And can answers be changed later in Profile, with a new score?
- Age: is it worked out from the date of birth given in onboarding (so it updates every birthday), or stored once? Should the date of birth be shown and locked too?
- Name: show the name as typed in "Your details", or the name read from the PAN card?
- If a user deletes KYC data or withdraws consent, do name and age become editable again?
- Old users who answered Risk before this change: keep their answers, or ask again?
- Home tiles and links that point to the Risk tab today need a new target. Same layout on web, Android and iOS.

---

## Idea 3: Profile asks the retirement questions and suggests numbers for each FIRE type

Added 2026-11-09 by Nitish. Status: **idea, waiting**.

### What Nitish wants

- The **Profile** tab asks for the age the person wants to retire at, plus the other details needed to plan retirement.
- From those numbers, the app suggests the right corpus for **Lean FIRE, FIRE, Barista FIRE and Fat FIRE**, and the **SIP needed per month** to reach each one.
- Method and fields come from this video: [YouTube ZnPV8V59in8 (from 5:09)](https://www.youtube.com/watch?v=ZnPV8V59in8&t=309s). Nitish has the **Excel sheet** shown in the video and will share it. The spec follows the sheet's inputs and formulas.

### What exists today (so the spec only adds what is new)

- Profile already has: name, age, city, dependents, take-home pay, current SIP, retire age, plan-till age, optional monthly spend, FIRE goal picker (Lean / FIRE / Barista / Fat), part-time income for Barista (PR #1, PR #4).
- FIRE plan already shows: FIRE number, projected corpus, SIP needed with yearly step-up, earliest FIRE age, and a side-by-side table of all 4 FIRE types with corpus, SIP and FIRE age. Lean = 70% of spend, FIRE = 100%, Barista = spend minus part-time income, Fat = 150% (PR #4).

### Questions to settle in the spec (once the Excel sheet is in)

- Which inputs from the sheet are missing in Profile today (for example current corpus, existing investments, expected return, inflation, step-up, life expectancy, withdrawal rate, one-off goals)?
- Do the sheet's multipliers or withdrawal rates for Lean, FIRE, Barista and Fat differ from today's 70% / 100% / spend minus part-time income / 150%? If so, the sheet wins.
- Should the 4 suggestions show on Profile itself, or stay on FIRE plan with Profile linking to them?
- Does this merge with Idea 2 (Risk inside Profile, locked name and age) into one Profile redesign?
- Same on web, Android and iOS; numbers must match the sheet exactly for the same inputs (golden tests built from the sheet).
