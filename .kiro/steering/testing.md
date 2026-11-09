---
inclusion: always
---

# Testing rule (before every push)

No Wealthfire branch is pushed, and no PR is opened or updated, until INDEPENDENT tester agents have run every test case in `CMD files/Wealthfire Test Cases.html` and Nitish has seen the failure report.

## Who tests

1. Testers are separate agents that did not build or review the change. Builders never mark their own work as tested.
2. The Chief of Staff decides how many testers to start. Use more than one when it saves time. Split by section of the test cases page, so each tester owns a set of TC ids and no case is run twice.
3. Parallel testers share one local server, so each tester:
   - uses only its own test users (from `LOCAL_PERSONAS`) or its own made-up contacts, never another tester's;
   - never calls Reset local data while other testers run. Only the Chief of Staff resets, before and after the whole run;
   - uses a new browser context per case (like an InPrivate window).
   Cases that need Reset, or that change shared data (for example "PAN already used"), run in one tester, last.

## How to test

4. Run on the local stack only (no AWS): the app at http://127.0.0.1:5180 (`localkyc` mode), the KYC server and Local test home at http://127.0.0.1:5181, the review console at http://127.0.0.1:5182. Nitish starts it with `CMD files/Wealthfire Preview.cmd` if the agent tools cannot start servers. Testers never stop his server windows.
5. Drive the installed Edge with `playwright-core` pinned to an exact version, installed in the session scratch folder (never in the repo). Headless is fine.
6. Follow each case's steps literally and compare the screen with Expected Result. Status is Passed, Failed or Blocked. Blocked means it cannot run on this laptop (real phones, real Google/Gmail sign-in, a real webcam, a screen reader) and must say why.
7. Testers never edit the repo. They save scripts, screenshots and `results.json` in scratch.

## Report to Nitish

8. One combined report from the Chief of Staff:
   - counts: Passed / Failed / Blocked;
   - Failed table: TC id, section, objective, step, expected, actual (exact screen text), screenshot, likely cause, severity (must fix / should fix / minor);
   - Blocked table with reasons;
   - problems in the test cases themselves.
9. Update Status in the test cases page, the Kiro artifact `wealthfire-test-cases` and the OneDrive copy, and post the build tracker.
10. Failed must-fix cases are fixed and re-tested by a tester before the push, unless Nitish says otherwise.
