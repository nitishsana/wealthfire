---
inclusion: always
---

# Preview launcher rule

Nitish previews features by double-clicking `.cmd` files. Keep them all in one repo folder named `CMD files/`.

- `CMD files/_start-server.cmd`: shared helper (files are CRLF; `.gitattributes` enforces it). Starts the Vite server once at `http://127.0.0.1:5180` in its own window. Never edit the port or bind address.
- `CMD files/00 - All sections.cmd`: consolidated preview of the whole app, in the normal browser.
- `CMD files/01 - Onboarding.cmd`: onboarding only, in a fresh Edge InPrivate window, so it always starts at sign in.
- Scenario variants: when one section has several paths worth checking, add `CMD files/NN - <Section> (<scenario>).cmd` next to the main file, same number. Each opens the same page in a fresh Edge InPrivate window with a dev-only URL switch, and its `REM` notes say what to do to see that scenario. Onboarding has `01 - Onboarding (scenario 2 - misread).cmd`, `01 - Onboarding (scenario 3 - different number).cmd` and `01 - Onboarding (unreadable).cmd`, which pass `?reader=misread|different|unreadable` (`apps/web/src/docreader.ts`, read only when `import.meta.env.DEV`; the main `01 - Onboarding.cmd` passes `?reader=match`). Scenario switches are never shown in the app UI.
- `CMD files/NN - <Section>.cmd`: one file per app section (FEATURES.md category), two-digit numbers in nav order. Each opens `http://127.0.0.1:5180/<route>?preview=demo` in a fresh Edge InPrivate window.
- `?preview=demo` is handled by `apps/web/src/preview.ts`: in the Vite dev server only (`import.meta.env.DEV`), and only when the browser has no stored data, it loads the demo user with onboarding finished. It must never run in `npm run build` output and must never overwrite stored data.

When a feature adds or changes a section:

1. Add or update that section's `.cmd` in the same commit.
2. Use paths relative to the file (`%~dp0`), never absolute paths, so it works from any clone.
3. Put test values (sample inputs, demo codes) as `REM` comments at the top of the file.
4. Mention the files to double-click when asking Nitish to preview.
5. In git, launchers live only in the separate `CMD files/` folder, never in the repo root or `apps/`.
6. Nitish opens them from his project folder `C:\Users\sananiti\OneDrive - amazon.com\Desktop\1_Projects\My Personal Mirror\WealthFire`. Keep one same-named shortcut `.cmd` in its `CMD files\` subfolder per launcher (all shortcuts in that one folder, none loose in the project folder). Each shortcut only `call`s the repo file in `CMD files/`, so the logic lives in git. Add, rename or remove shortcuts whenever the repo `CMD files/` changes. The shortcuts are local and are not committed.
