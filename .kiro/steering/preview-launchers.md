---
inclusion: always
---

# Preview launcher rule

Nitish previews features by double-clicking `.cmd` files. Keep them in the repo's `preview/` folder.

- `preview/_start-server.cmd`: shared helper (files are CRLF; `.gitattributes` enforces it). Starts the Vite server once at `http://127.0.0.1:5180` in its own window. Never edit the port or bind address.
- `preview/00 - All sections.cmd`: consolidated preview of the whole app, in the normal browser.
- `preview/01 - Onboarding.cmd`: onboarding only, in a fresh Edge InPrivate window, so it always starts at sign in.
- `preview/NN - <Section>.cmd`: one file per app section (FEATURES.md category), two-digit numbers in nav order. Each opens `http://127.0.0.1:5180/<route>?preview=demo` in a fresh Edge InPrivate window.
- `?preview=demo` is handled by `apps/web/src/preview.ts`: in the Vite dev server only (`import.meta.env.DEV`), and only when the browser has no stored data, it loads the demo user with onboarding finished. It must never run in `npm run build` output and must never overwrite stored data.

When a feature adds or changes a section:

1. Add or update that section's `.cmd` in the same commit.
2. Use paths relative to the file (`%~dp0`), never absolute paths, so it works from any clone.
3. Put test values (sample inputs, demo codes) as `REM` comments at the top of the file.
4. Mention the files to double-click when asking Nitish to preview.
