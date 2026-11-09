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

- ~~Bucket 1 target: 2 or 3 years by default, and can the user choose?~~ **Answered (Nitish, Idea board comment): the buckets are fixed, not a user choice.** Still to confirm in the spec: the fixed Bucket 1 size, 2 or 3 years (the video sheet uses 3).
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

### Answers from Nitish (2026-11-09)

| Question | Answer |
|---|---|
| Which "KYC completed" starts the risk cards? | The **end of onboarding** ("KYA" meant KYC). |
| One question per card? | **Yes**, one question per card. |
| Can the risk answers be changed later? | **Yes**, in the **Risk section inside the Profile tab** (the Risk tab moves there as a collapsible section). |
| Date of birth | **Locked**: shown, cannot be edited. |
| Name | Always the **name as per the PAN card**. Onboarding does not move past the check until the typed name matches the PAN card, so the name is always in sync with the PAN; Profile shows it read-only. |
| Users who already answered Risk | Keep their answers; they can change them later in the Risk section in Profile. |
| Can the risk cards be skipped? | **No.** They are mandatory; the user cannot skip them. |
| Age | Worked out from the locked date of birth, so it **goes up every year** on the birthday. |
| After "Delete my KYC data" | **All of the user's data is erased** (name, date of birth, age and the rest). |
| Withdraw consent | **Removed as a separate option.** The only way out is "Delete my KYC data". |

**Change to what is live today:** Profile currently has both "Withdraw consent" and "Delete my KYC data" (PR #10). This idea removes the "Withdraw consent" button, its server routes stay unused or are removed, and the test cases for it (TC-72, TC-79) are retired. Note for the compliance adviser: India's data protection law expects users to be able to withdraw consent; "Delete my KYC data" must count as that withdrawal and say so in its text.

| Records the law requires after "Delete my KYC data" | **Keep them in the KYC server's database and handle them by the rules** (Nitish, Idea board comment). Everything else is erased. |

**How the kept records are handled** (to confirm with the compliance adviser):
- Keep only what KYC and anti-money-laundering rules require for a verified KYC (for example the KYC record, consent and audit trail), for the retention period the adviser sets (`DOC_RETENTION_DAYS`). Everything else is erased at once.
- Encrypted at rest, in India (ap-south-1), reachable only by authorised staff, every access audited (as built in PR #10).
- Never used for anything else (no planning, no marketing); deleted automatically when the retention period ends.
- The delete confirmation tells the user that some records are kept because the law requires it, and for how long.

### Still open (ask Nitish in the spec)

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

### The video's method (Kirttan Shah, DIY retirement planning, shared by Nitish)

- No government pension in India: active income stops near 60, so build a corpus that lasts to 85 or beyond.
- Start from monthly expenses **excluding EMIs**, because loans should be paid off before retirement.
- Inflate them (e.g. 6%) to the retirement date, then work out the **lump sum needed at retirement** for the years to the life-expectancy age.
- Split the corpus into 3 buckets:
  1. **Liquidity (Bucket 1):** 3 years of expenses in arbitrage funds.
  2. **Income (Bucket 2):** the rest, in hybrid funds, drawn with a systematic withdrawal plan.
  3. **Wealth (Bucket 3):** 20% of the corpus in equity funds, for long-term growth.
- Its bucket rule (3 years / the rest / 20%) differs from Idea 1 (2-3 years / 5 years / the rest). The spec picks one, or offers both.

### The sheet (Retirement Planner Sheet, shared 2026-11-09)

The sheet came as a CSV, which keeps values but not formulas. The formulas below were worked out from its values and reproduce every number in it exactly. A local copy is kept outside the repo: `wealthfire-tc\Retirement_Planner_Sheet.csv`. It is a third-party sheet, so only the method is stored here.

**Inputs**

| Input | Sheet example | Note in the sheet |
|---|---|---|
| Current age | 38 | |
| Retirement age | 55 | |
| Live up to | 85 | Life expectancy |
| Monthly expenses, excluding EMI | 1,00,000 | |
| Inflation rate | 6% | 6% is a fair expectation |
| Rate of return after retirement | 2% | Assumed low, because rates fall over time |
| Estate to leave behind | (blank) | Amount left after you |
| Existing investments for retirement | 10,00,000 | Current value |
| EPF, gratuity, leave encashment, NPS expected | 11,00,000 | Received at retirement |
| Rate of return before retirement | 10% | Use 9-10% if mostly fixed income |

**Formulas** (Y = retirement age minus current age; N = live-up-to minus retirement age)

| Output | Formula | Sheet example |
|---|---|---|
| Monthly expense at retirement | expense x (1 + inflation)^Y | 2,69,277.28 |
| Yearly expense at retirement (E) | monthly x 12 | 32,31,327 |
| Corpus needed at retirement (C) | Excel `PV(post-return, N, -E, -estate, 1)`, paid at the start of each year | 7,38,17,685 |
| Monthly SIP needed | Excel `PMT(pre-return/12, Y x 12, existing, -(C - EPF), 1)`: existing investments compound monthly at the pre-retirement return; SIP paid at the start of each month | 1,25,363 (if the result is 0 or less, no SIP is needed) |
| Bucket 1 | 3 x E | 96,93,982 |
| Bucket 3 | 20% x C | 1,47,63,537 |
| Bucket 2 | C - Bucket 1 - Bucket 3 | 4,93,60,166 |
| Bucket 2 lasts (years) | Excel `NPER(post-return, -E, Bucket 2, 0, 1)` | 17.98 |
| Bucket 3 grows to | Bucket 3 x (1 + pre-return)^(3 + Bucket 2 years) | 10,90,13,205 |

Note: the sheet keeps the yearly expense flat after retirement and uses the low 2% return to allow for that, rather than adding inflation every year.

**Golden test:** with the inputs above, the app must show exactly the sheet's outputs (to the rupee, and 17.98 years).

**Everything depends on the user's current age and chosen retirement age** (Nitish, 2026-11-09). The years to retirement (Y) set how much today's spend inflates, how long the corpus must last (to the live-up-to age) and how many months of SIP there are. Change either age and the corpus and monthly SIP are worked out again at once. Same sheet inputs, only the ages changed:

| Current age | Retire at | Years to go | Corpus needed | SIP per month |
|---|---|---|---|---|
| 38 | 50 | 12 | 6,15,69,812 | 2,05,087 |
| 38 | 55 | 17 | 7,38,17,685 | 1,25,363 |
| 38 | 60 | 22 | 8,61,12,691 | 79,147 |
| 30 | 55 | 25 | 11,76,54,175 | 78,106 |
| 45 | 55 | 10 | 4,90,92,976 | 2,19,247 |

(Starting younger needs a bigger corpus, because today's spend inflates for longer, but a smaller SIP, because there are more months to invest.)

**Lean / FIRE / Barista / Fat:** the sheet has one goal. Each FIRE type changes the expense used: today Lean = 70%, FIRE = 100%, Fat = 150%, Barista = expense minus part-time income. Then the same formulas run for each type, giving a corpus and SIP per type.

### Questions to settle in the spec (once the Excel sheet is in)

- Which inputs from the sheet are missing in Profile today (for example current corpus, existing investments, expected return, inflation, step-up, life expectancy, withdrawal rate, one-off goals)?
- Do the sheet's multipliers or withdrawal rates for Lean, FIRE, Barista and Fat differ from today's 70% / 100% / spend minus part-time income / 150%? If so, the sheet wins.
- Should the 4 suggestions show on Profile itself, or stay on FIRE plan with Profile linking to them?
- Does this merge with Idea 2 (Risk inside Profile, locked name and age) into one Profile redesign?
- Same on web, Android and iOS; numbers must match the sheet exactly for the same inputs (golden tests built from the sheet).

---

## Idea 4: Retirement planner flow, right after the risk profile (first time only)

Added 2026-11-09 by Nitish. Status: **idea, waiting**.

### What Nitish wants

- **Order for a new user:** onboarding → KYC → risk profile cards (Idea 2) → **Retirement planner** flow straight away.
- **Retirement planner** asks, step by step, everything needed to work out the right **monthly SIP**: the Idea 3 inputs (current age, retirement age, live-up-to age, monthly spend excluding EMIs, inflation, returns before and after retirement, existing investments, EPF / gratuity / leave encashment / NPS, estate).
- **At the end,** it shows the result (corpus and SIP per month for each FIRE type, from Idea 3) and **writes every answer into the Profile tab**, so the user does not type anything twice.
- **Runs once:** only for first-time users who have not finished the Retirement planner. After that, the user changes the numbers in Profile.

### Links to other ideas

- Starts after Idea 2's risk cards; uses Idea 3's inputs and formulas (golden numbers from the sheet).
- Ideas 2, 3 and 4 together reshape the first-run journey and Profile, so the spec may combine them.

### Questions to settle in the spec (ask Nitish then, not now)

- Can the user leave the planner halfway and resume it later, or skip it? Does it block the rest of the app until done?
- Existing users who already filled Profile: do they see the planner once, pre-filled, or never?
- Which answers are pre-filled from onboarding (age from date of birth, spend from Expenses) and which are always asked?
- One question per screen or grouped screens; a progress bar; a Back button?
- Does the end screen pick one FIRE type as the goal (today's Profile "FIRE goal")?
- Same flow on web, Android and iOS.

---

## Idea 5: Slimmer Profile and a new "Retirement planner" tab

Added 2026-11-09 by Nitish. Status: **idea, waiting**.

### What Nitish wants

- **Profile tab: remove** the field "People who depend on you".
- **Move out of Profile into a new tab called "Retirement planner":**
  - Monthly take-home pay
  - Current monthly SIP
  - Age you want to retire
  - Plan money till age
  - All the cards under "Which FIRE are you aiming for?" (Lean, FIRE, Barista, Fat, with the Barista part-time income box)
- **Profile keeps** the personal details (name, age, city; and, with Idea 2, the risk profile toggle and the locked name and age).

### Links to other ideas

- **Idea 4:** the first-run Retirement planner flow should now save its answers into this **Retirement planner tab** (not Profile).
- **Idea 3:** its extra inputs (live-up-to age, spend without EMIs, inflation, returns, existing investments, EPF / NPS / gratuity, estate) and the suggested corpus and SIP per FIRE type also belong in this tab.
- **Idea 1:** the bucket simulator could sit here too, or stay on the Buckets page.

### Questions to settle in the spec (ask Nitish then, not now)

- Is dependents used anywhere today (for example in the FIRE number)? If so, drop it from the maths too, or keep a default?
- Existing users' saved dependents value: delete it, or keep it hidden?
- Where does the new tab sit in the menu, and does FIRE plan merge into it or stay separate?
- Home tiles and links that open these fields in Profile today need the new target. Same on web, Android and iOS.

---

## Idea 6: Find and link all accounts by phone number, then fill Net worth

Added 2026-11-09 by Nitish. Status: **idea, waiting**.

### What Nitish wants

- **When:** the next flow after the risk profile is done.
- **Find accounts by phone number:** automatically fetch every account mapped to the user's phone number:
  - bank accounts
  - EPFO (provident fund)
  - Demat accounts (stocks, mutual funds)
  - NPS accounts
- **Choose:** show all the accounts found. The user can **untick any account** they don't want linked.
- **Fetch the money data:** for the accounts kept, fetch the credits and debits (and balances or holdings).
- **Fill Net worth:** put everything into the **Net worth** tab, sorted into **Assets** (bank balances, EPF, Demat holdings, NPS, deposits) and **Liabilities** (loans, credit card dues).
- **Loans too (Nitish, 2026-11-09):** loans mapped to the phone number (home, car, personal, education, gold, loan against property, credit card dues) are also found and fetched, each with lender, outstanding amount, EMI and end date where available. Every loan is mapped to **Liabilities** in the Net worth tab, and its EMI feeds the "total EMIs" figure Net worth shows today.

### Notes for the spec

- In India this is done through the RBI **Account Aggregator** framework: a licensed AA (for example Finvu, OneMoney, Setu, Anumati) finds accounts linked to the mobile number and shares data only after the user approves a **consent** on the AA's screen. Wealthfire would need an AA / FIU partner agreement and its sandbox, like the KYC partner. Already noted as a gap: "Bank links need an Account Aggregator partner and are not built".
- Loan data: check which lenders share loans and credit cards through the AA (banks and NBFCs as data providers). For loans the AA does not cover, a credit bureau report (CIBIL, Experian, Equifax, CRIF, with the user's consent) lists all loans against the PAN; the spec decides whether to use it.
- Coverage to check with the partner: banks and deposits are widely available; Demat (via NSDL / CDSL), mutual funds (CAS) and NPS (via the CRAs) are available through some AAs; **EPFO** may not be available through AAs yet and could need another route (for example the EPF passbook / UAN). Loans and credit cards: check which lenders share liabilities.
- Consent rules: purpose, which data, how long, how often; the user can revoke. Data handling follows the same privacy and retention rules as KYC (adviser to confirm).
- Today's app: Connect page has "Coming soon" placeholders for Bank, CAS, Stocks/broker and EPF/NPS; Net worth is typed in by hand; Expenses reads card statements and Gmail alerts. Fetched debits could also feed Expenses.

### What INDmoney captures for net worth (research, 2026-11-09)

Checked INDmoney's public pages to see which sources a full, correct net worth needs. Summary in our own words, with links:

| Source | How INDmoney gets it | Route for Wealthfire | Net worth side |
|---|---|---|---|
| Savings, current accounts, fixed deposits (any bank) | Synced bank accounts ([net worth page](https://www.indmoney.com/networth)) | Account Aggregator | Asset |
| Mutual funds held anywhere | MF Central OTP consent, consolidated statement against the PAN ([track external funds](https://www.indmoney.com/mutual-funds/track-mutual-funds)) | MF Central / CAMS-KFintech CAS, or AA | Asset |
| Indian stocks across brokers and Demat accounts | Holdings synced across every broker ([track brokers](https://www.indmoney.com/stocks/track-brokers)) | NSDL / CDSL CAS, or AA | Asset |
| US stocks | Its own US investing account | Manual entry (or a broker link later) | Asset |
| EPF | PF records under the UAN ([EPFO tracker](https://www.indmoney.com/networth/track-epfo-account)) | UAN-based fetch (not through AA) | Asset |
| NPS | NPS balance and contributions tracker ([track all investments](https://indmoney.com/features/track-all-investments)) | NPS CRA, or AA | Asset |
| PPF, other deposits | Listed among tracked items ([how the tracker started](https://www.indmoney.com/blog/personal-finance/the-idea-behind-networth-on-indmoney)) | Bank / post office via AA where available, else manual | Asset |
| Credit cards, loans, EMIs | Listed among tracked items (same blog) | AA for lenders that share; credit bureau report for the rest | Liability |
| Insurance policies | Listed among tracked items (same blog) | Manual entry (policy, cover, premium) | Shown separately (cover is not net worth; surrender value can be an asset) |
| Family members | Separate and combined family net worth ([family accounts](https://www.indmoney.com/networth/family-accounts)) | Moved to **Idea 7** | Both |

Other things a correct net worth usually needs, typed in by hand: gold (physical and Sovereign Gold Bonds), real estate, recurring deposits and post office schemes, company shares (ESOP / RSU / ESPP), cash, money lent to others, and crypto.

### Decided: every source above is in Idea 6 (Nitish, 2026-11-09)

All of these are connected in this idea; the account-linking flow and the Net worth tab must cover each one:

| # | Source | Connected by | Net worth side |
|---|---|---|---|
| 1 | Bank savings and current accounts | Account Aggregator (found by phone number) | Asset |
| 2 | Fixed deposits | Account Aggregator | Asset |
| 3 | Mutual funds held anywhere | MF Central / CAMS-KFintech CAS with OTP consent | Asset |
| 4 | Indian stocks and ETFs across all brokers and Demat accounts | NSDL / CDSL CAS, or Account Aggregator | Asset |
| 5 | US stocks | Typed in by hand (broker link later if available) | Asset |
| 6 | EPF | UAN-based fetch | Asset |
| 7 | NPS | NPS CRA, or Account Aggregator | Asset |
| 8 | PPF and other small savings | Account Aggregator where the bank or post office shares it, else typed in | Asset |
| 9 | Loans (home, car, personal, education, gold, loan against property) | Account Aggregator, plus credit bureau report for lenders not on AA | Liability |
| 10 | Credit cards and EMIs | Account Aggregator, plus credit bureau report | Liability |
| 11 | Insurance policies | Typed in (policy, cover, premium, surrender value) | Cover shown separately; surrender value is an asset |
| 12 | Gold and Sovereign Gold Bonds | Typed in (SGBs may come through the Demat CAS) | Asset |
| 13 | Real estate | Typed in | Asset |
| 14 | Recurring deposits, post office schemes | Account Aggregator where available, else typed in | Asset |
| 15 | Company shares (ESOP / RSU / ESPP) | Typed in | Asset |
| 16 | Cash and money lent to others | Typed in | Asset |
| 17 | Crypto | Typed in | Asset |

Family members are a separate idea (Idea 7).

### Questions to settle in the spec (ask Nitish then, not now)

- Build all 17 sources at once, or in waves (connected sources first, typed-in ones next)?
- **Order:** Idea 4 says the Retirement planner starts right after the risk profile; this idea also comes right after it. Which comes first, or does account linking feed the planner (existing investments, EPF, NPS filled in automatically)?
- Can the user skip linking and type numbers by hand instead?
- How often are accounts refreshed (once, daily, on opening the app)?
- Do fetched debits also go into Expenses, with categories?
- Manual entries already in Net worth: keep beside the linked ones, replace, or ask?
- Loans not found through the AA: add a credit bureau check, or let the user add them by hand?
- Can the user untick a loan? (Unticking would hide a real liability, so Net worth would look higher.)
- Which AA partner, and what happens on the local test mode (a fake AA like the fake KYC partner)?
- Same flow on web, Android and iOS.

---

## Idea 7: Family net worth

Added 2026-11-09 by Nitish. Status: **idea, waiting**. Split out of Idea 6.

### What Nitish wants

- Add family members (for example spouse, parents, children) to the user's account.
- Track each member's net worth **separately**, and see the **combined family** net worth, assets and liabilities, without mixing their accounts.
- Similar to INDmoney's Family Accounts ([family accounts](https://www.indmoney.com/networth/family-accounts)).

### Links to other ideas

- Uses Idea 6's sources (all 17) for each member.
- Could later feed a family retirement plan (Ideas 3, 4 and 5).

### Questions to settle in the spec (ask Nitish then, not now)

- Who can be added, and how: does each member sign in and approve consent for their own accounts (needed for Account Aggregator and KYC data), or can the main user add typed-in numbers for them?
- What can each member see: only their own, or the whole family?
- Can a member leave or be removed, and what happens to their data?
- Joint accounts and joint loans: count once, or split between members?
- Is KYC needed for each member, or only for members who invest?
- Same on web, Android and iOS.

---

## Idea 8: CIBIL credit score in the Net worth tab

Added 2026-11-09 by Nitish. Status: **idea, waiting**.

### What Nitish wants

- Fetch the user's **CIBIL score**.
- Show it **inside the Net worth tab**.
- **Whenever the score changes**, show the change (for example "Your CIBIL score went up 12 points to 781").

### Notes for the spec

- The score comes from a credit bureau (TransUnion CIBIL; others are Experian, Equifax and CRIF High Mark), through a bureau partnership or a licensed reseller, with the user's consent and an OTP. It is pulled against the PAN and the mobile number already verified in onboarding.
- The same credit report also lists all loans and credit cards, so it can feed **Idea 6's liabilities** (loans not found through the Account Aggregator).
- A user's own check is a "soft" enquiry and does not lower the score.
- Consent, storage and deletion follow the same rules as KYC data; "Delete my KYC data" (Idea 2) also erases the credit report, except anything the law requires to keep.

### Answers from Nitish (Idea board comments, 2026-11-09)

| Question | Answer |
|---|---|
| Which bureau? | The **best and most used bureau in India**. Today that is TransUnion CIBIL; Experian, Equifax and CRIF High Mark are the alternatives if CIBIL is not available through the partner. |
| How often to refresh? | **Automatically once every 15 days** (this overrides an earlier "monthly" note). When the user logs in and 15 days have passed since the last pull, refresh then. |
| How is a change shown? | On the Net worth tab, **and a notification** is sent whenever the score changes. |
| Score history chart and main reasons | **Not now**: moved to a later idea (Idea 9). |
| No credit history (no score) | Show a short message encouraging the user to **build a credit history** going forward. |
| Platforms | **Consistent on web, Android and iOS, and across browsers and devices.** |

### Still open (ask Nitish in the spec)

- Cost per pull from the partner, and who pays.
- Notification channel: in-app only, or also push notification / SMS / email?
- Exact wording of the change notification and the no-score message.

---

## Idea 9: Credit score history and reasons (later)

Added 2026-11-09 by Nitish (split from Idea 8, "for future consideration, not right now"). Status: **idea, later**.

### What Nitish wants

- A **chart of the credit score over time** (each 15-day refresh from Idea 8).
- The **main reasons** behind the score and its changes (for example late payments, how much of the credit limit is used, age of accounts, number of new loan enquiries), with simple tips to improve it.

### Questions to settle in the spec (ask Nitish then, not now)

- How far back the chart goes, and whether old points are kept after "Delete my KYC data" (Idea 2 says all data is erased).
- Which reasons the bureau partner actually provides.
- Same on web, Android and iOS, across browsers and devices.
