---
inclusion: always
---

# Multi-agent development rule

Use as many agents as the work allows, running in parallel. Every feature follows this order.

## 1. Design first

- Write the spec (requirements, design, tasks) and get Nitish's approval before any code.
- The approved `tasks.md` is the execution plan. Agents build only what it lists.

## 2. One orchestrator, many builders

- One **orchestrator** agent owns the plan. It does not write feature code.
- It splits the tasks into independent parts (for example: core logic + tests, web screens, mobile screens) and hands each to its own **builder** agent at the same time.
- Each builder gets: its task numbers, the files it owns, the checks it must pass, and when to stop. Two builders never edit the same file. Work that depends on another part waits for that part.
- Builders report only to the orchestrator. The orchestrator merges the parts and gives Nitish one combined report.

## 3. Independent plan check

- A separate **reviewer** agent, not the orchestrator and not a builder, checks the finished work against the approved `requirements.md`, `design.md` and `tasks.md`.
- It does not see the builders' chat. It reads the code and the spec only.
- It reports, task by task: done as planned, done differently (and how), or missing.
- Gaps go back to the orchestrator to fix before anything is shown to Nitish.

## 4. Bug check when a merge starts

When Nitish approves a push/merge to GitHub (see `git-workflow.md`):

- Before the PR is merged, run a bug review across the **whole user flow** the feature touches, end to end, on web, Android and iOS. Not just the changed files.
- Run every check in `project-overview.md`, and wait for CI to pass.
- List every bug found in the PR description and in the report to Nitish, with: where it is, what goes wrong, and how serious it is (must fix / should fix / minor).
- Do not merge while a "must fix" bug is open. Fix it, re-run the checks, then ask Nitish again.
