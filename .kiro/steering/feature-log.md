---
inclusion: always
---

# Feature log rule

1. The feature log is `FEATURES.md` at the repo root.
2. Format: one section per app category (Platform, Home, Profile, Risk, Net worth, Expenses, FIRE plan, Portfolio, Buckets, Progress, Connect, Settings, plus any new tab such as Login). Each section is a table with columns `Date | Category | Feature Description`.
3. Only merged features go in. Date = merge date into `main` (IST). End each description with the PR number, e.g. `(PR #5)`.
4. When a feature is built, add its rows to `FEATURES.md` in the same commit set that will be merged, so the log and the code land together.
5. Never list features that are only local, unpushed, or in an open PR. If a PR is closed without merging, remove its rows.
6. A new category (new tab or section) gets its own new section.
7. Update the "Last updated" line each time.
