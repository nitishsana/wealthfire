---
inclusion: always
---

# Preview and test-case rule

Nitish previews and tests with exactly **two files** in the repo folder `CMD files/`:

- `CMD files/Wealthfire Preview.cmd`: the only launcher. Starts the Vite dev server once at `http://127.0.0.1:5180` (never change the port or bind address) and opens a fresh Edge InPrivate window. CRLF line endings (`.gitattributes` enforces it), paths relative to the file (`%~dp0`).
- `CMD files/Wealthfire Test Cases.csv`: every test case, with the columns **Section, Test Objective, Testing Steps, Expected Result**. Saved as UTF-8 with BOM so Excel opens it cleanly.

Rules:

1. Do not add more `.cmd` files. Scenarios and sections are reached by links written in the test cases, in the same preview:
   - demo document scenarios: `http://127.0.0.1:5180/?reader=demo&mode=match|misread|different|unreadable`
   - a single section with onboarding skipped: `http://127.0.0.1:5180/<route>?preview=demo`
   These switches work only in the dev server (`import.meta.env.DEV`), never on the live site.
2. Every feature that adds or changes behaviour adds or updates its rows in the test cases file in the same commit. Group rows by Section (app section, e.g. Onboarding - Upload documents, Expenses, Settings - Account).
3. Steps must be concrete (exact values, links and buttons); Expected Result must say exactly what appears on screen.
4. Nitish opens both files from `C:\Users\sananiti\OneDrive - amazon.com\Desktop\1_Projects\My Personal Mirror\WealthFire\CMD files\`. Keep there: a shortcut `Wealthfire Preview.cmd` that only `call`s the repo launcher, and a copy of the test cases file, refreshed whenever the repo file changes. Nothing else in that folder.
5. When asking Nitish to preview, point him to these two files.
