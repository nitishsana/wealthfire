---
inclusion: always
---

# Preview and test-case rule

Nitish previews and tests with exactly **two files** in the repo folder `CMD files/`:

- `CMD files/Wealthfire Preview.cmd`: the only launcher. Starts, on this computer only, the local KYC server (`npm run local -w @wealthfire/kyc-service`: `http://127.0.0.1:5181`, which also serves the review console on `http://127.0.0.1:5182`) and the Vite dev server in `--mode localkyc` at `http://127.0.0.1:5180` (never change the ports or bind address). When all three are up it opens the test cases page and the **Local test home** `http://127.0.0.1:5181/` in a fresh Edge InPrivate window (sign in there as a test user or as the demo reviewer; Reset local data). CRLF line endings (`.gitattributes` enforces it), paths relative to the file (`%~dp0`).
- `CMD files/Wealthfire Test Cases.html`: every test case as a self-contained HTML page (opened by the launcher), grouped by section in collapsible blocks, columns **#, Section, Test Objective, Testing Steps, Expected Result, Status** (Passed / Failed / Blocked / Not run). No CSV.
- The same test cases are mirrored in the Kiro artifact `wealthfire-test-cases` (theme variables, status counts at the top). Page and artifact always match.

Rules:

1. Do not add more `.cmd` files. Scenarios and sections are reached by links written in the test cases, in the same preview:
   - demo document scenarios: `http://127.0.0.1:5180/?reader=demo&mode=match|misread|different|unreadable`
   - a single section with onboarding skipped: `http://127.0.0.1:5180/<route>?preview=demo`
   These switches work only in the dev server (`import.meta.env.DEV`), never on the live site.
   - a test user: `http://127.0.0.1:5180/?persona=<id>` (ids from `LOCAL_PERSONAS` in `packages/core/src/localPersonas.ts`; the Local test home buttons open these). Own browser storage space (`wf.persona.<id>.` keys), mobile, DEMO code and Your details filled in, 'Test user: <name> · Switch user' bar. Add `&reader=demo&mode=…` when a case needs the demo reader.
   - demo mode with no server: `http://127.0.0.1:5180/?server=off`.
   `?persona=` and `?server=off` work only in the `localkyc` build (VITE_API_URL on 127.0.0.1 / localhost, `apps/web/.env.localkyc`); any other build ignores them. Test case steps never ask for terminal commands.
2. Every feature that adds or changes behaviour adds or updates its rows in the HTML page in the same commit, and the artifact is updated at the same time. When Nitish reports results (e.g. 'TC-05 passed'), update Status in both and the counts. Group rows by Section (app section, e.g. Onboarding - Upload documents, Expenses, Settings - Account).
3. Steps must be concrete (exact values, links and buttons); Expected Result must say exactly what appears on screen.
4. Nitish opens both files from `C:\Users\sananiti\OneDrive - amazon.com\Desktop\1_Projects\My Personal Mirror\WealthFire\CMD files\`. Keep there: a shortcut `Wealthfire Preview.cmd` that only `call`s the repo launcher, and a copy of the HTML test cases page, refreshed whenever the repo file changes. Nothing else in that folder.
5. When asking Nitish to preview, point him to these two files.
