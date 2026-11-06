---
inclusion: always
---

# Multi-agent development rule

Use as many agents as the work allows, running in parallel. Every feature follows this order.

## 0. Ask, don't guess (applies to every task and every agent)

- If anything in a task is unclear, missing or open to more than one reading, raise the question and get Nitish's answer before building that part.
- Ask in chat, 1–3 questions at a time, each with a recommended answer.
- Builders and reviewers send their questions to the orchestrator, who collects them and asks Nitish in one message.
- Never fill a gap with a silent assumption. If work must continue meanwhile, build only the parts the question does not touch, and list the open question in the report.

## 1. Design first

- Write the spec (requirements, design, tasks) and get Nitish's approval before any code.
- The approved `tasks.md` is the execution plan. Agents build only what it lists.

## 1a. Chief of Staff and section leads

```
Chief of Staff (master orchestrator, the main session; only voice to Nitish)
├── Platform lead   — shared files: packages/core types/store/features, CI, CMD files, steering
├── Onboarding lead ── its own sub-agents (e.g. core logic, web screens, phone screens, camera/crop)
├── Home lead, Profile lead, Expenses lead, FIRE plan lead, … (one per FEATURES.md section, only when that section has work)
└── Reviewer(s)     — independent, report straight to the Chief of Staff
```

- **Chief of Staff** is the master orchestrator. Every build approval goes to it first. It decides which section leads to start and what each owns, and gives Nitish the single combined report. It does not write feature code.
- **Section leads** (one per app section that has approved work: Onboarding, Home, Profile, Risk, Net worth, Expenses, FIRE plan, Portfolio, Buckets, Progress, Connect, Settings, plus new sections) plan their section's work, create and run their own sub-agents, and report one result to the Chief of Staff. A lead's sub-agent may lead its own group in turn.
- **Platform lead** owns files shared by many sections (`packages/core/src/types.ts`, `store.ts`, `features.ts`, `index.ts`, CI, `CMD files/_start-server.cmd`, steering). Section leads ask it for shared changes instead of editing those files themselves.
- Leads are started only for sections with approved work; an idle section gets no agent.

## 1b. Every build approval goes to the Chief of Staff first

- When Nitish approves a build (a spec, a change request or a fix batch), hand it to the **Chief of Staff** (orchestrator) before any builder starts.
- The orchestrator decides how many sub-agents are needed and how they are grouped. There is no fixed limit on the number of sub-agents or on the depth of the hierarchy.
- A sub-agent may itself be an **orchestrator** for a group below it (for example: a "web" lead that splits into screens, styles and tests). Each lead owns its group's split, file ownership and checks, and reports one combined result upward.
- Every level follows the same rules: no two agents edit the same file, dependent work waits for what it needs, questions go up the chain to Nitish (step 0), and nothing is pushed or merged without his yes.
- The top orchestrator alone reports to Nitish.
- Capacity is a ceiling, not a target: split only where the parts can really run in parallel.

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
