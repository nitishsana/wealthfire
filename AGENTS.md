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
   - `.kiro/steering/apps-in-sync.md`: a change to one app updates every app it touches
   - `.kiro/steering/testing.md`: independent testers run all test cases before any push
   - `FEATURES.md`: everything merged so far
4. `git log --oneline -15` to see recent changes, including ones made outside this tool.

## How to build a feature

0. Any question in any task: raise it and get Nitish's answer before building that part. No silent assumptions.
1. Design first: spec (requirements, design, tasks), approved by Nitish.
2. A **Chief of Staff** (master orchestrator) runs every build, with one **section lead** per app section that has work (Onboarding, Home, …) and a **Platform lead** for shared files. Every build approval goes to the Chief of Staff first. It decides how many sub-agents to create and how to group them; there is no limit on count or depth, and a sub-agent can lead its own group. Agents split the approved tasks in parallel, and only the top orchestrator reports to Nitish.
3. A separate reviewer agent checks the work against the approved plan.
4. When a merge starts, check the whole flow for bugs and list each one (must fix / should fix / minor) before merging.

Full rule: `.kiro/steering/agent-workflow.md`.

## Previewing

Double-click `CMD files/Wealthfire Preview.cmd` (the only launcher) and follow `CMD files/Wealthfire Test Cases.html` (Section, Test Objective, Testing Steps, Expected Result, Status; mirrored in the Kiro artifact `wealthfire-test-cases`). Scenarios and sections are links inside the test cases. Every feature updates the test cases in the same commit. Rule: `.kiro/steering/preview-launchers.md`.

## Before handing work back

- Run the checks in `project-overview.md`.
- Add merged features to `FEATURES.md`.
- If you learn a new rule, add it to `.kiro/steering/` so the next tool sees it.
