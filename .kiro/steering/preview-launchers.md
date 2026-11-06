---
inclusion: always
---

# Preview launcher rule

Nitish previews features by double-clicking `.cmd` files. Keep them in the repo's `preview/` folder.

- `preview/_start-server.cmd`: shared helper. Starts the Vite server once at `http://127.0.0.1:5180` in its own window. Never edit the port or bind address.
- `preview/0 - All sections.cmd`: consolidated preview of the whole app.
- `preview/<n> - <Section>.cmd`: one file per app section (FEATURES.md category), opening only that section's flow. Number them in nav order.

When a feature adds or changes a section:

1. Add or update that section's `.cmd` in the same commit.
2. Use paths relative to the file (`%~dp0`), never absolute paths, so it works from any clone.
3. Put test values (sample inputs, demo codes) as `REM` comments at the top of the file.
4. Mention the files to double-click when asking Nitish to preview.
