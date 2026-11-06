# Start here (for any AI tool or developer)

GitHub `main` is the source of truth. Chat history is not.

## Every new session

1. `git fetch origin` and `git status`. Commit or set aside any local work first.
2. `git switch -c <new-branch> origin/main` so work starts from the latest code.
3. Read these, in order:
   - `.kiro/steering/project-overview.md`: layout, how to add a feature, checks
   - `.kiro/steering/git-workflow.md`: batch features, preview, ask before push/merge
   - `.kiro/steering/feature-log.md`: how to update the feature log
   - `.kiro/steering/agent-workflow.md`: design first, one orchestrator with parallel builders, an independent plan reviewer, and a full-flow bug check before merge
   - `FEATURES.md`: everything merged so far
4. `git log --oneline -15` to see recent changes, including ones made outside this tool.

## How to build a feature

1. Design first: spec (requirements, design, tasks), approved by Nitish.
2. One orchestrator agent splits the approved tasks across parallel builder agents and reports to Nitish as one voice.
3. A separate reviewer agent checks the work against the approved plan.
4. When a merge starts, check the whole flow for bugs and list each one (must fix / should fix / minor) before merging.

Full rule: `.kiro/steering/agent-workflow.md`.

## Before handing work back

- Run the checks in `project-overview.md`.
- Add merged features to `FEATURES.md`.
- If you learn a new rule, add it to `.kiro/steering/` so the next tool sees it.
