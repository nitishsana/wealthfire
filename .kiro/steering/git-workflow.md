---
inclusion: always
---

# Git workflow rule

1. Build features as local commits on a batch branch (e.g. `batch/next-release`). Do not push, open PRs or merge on your own.
2. Nitish batches several features, then decides when to push.
3. Before merging, offer a local preview of the website (`npx vite --host 127.0.0.1 --port 5180` in `apps/web`) so Nitish can check it.
4. Push and merge only after Nitish says yes. Push with the branch named explicitly: `git push -u origin <branch>`. Never push to `main` directly.
5. Open a PR into `main`, wait for CI (check, mobile android, mobile ios) to pass, then merge. The `deploy` job runs after merge and publishes the website to GitHub Pages.
6. Update `FEATURES.md` in the same batch (see `feature-log.md`).
