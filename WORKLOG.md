# WORKLOG

Times are local (IST, UTC+05:30), taken from the machine clock while the work happened.
Tooling: Node.js 24, no dependencies. Built as a pairing session with Claude Code (AI
assistant). The design decisions come from a brainstorming session held earlier the same
morning (10:17–11:06). This log records what happened, including dead ends.

| Time  | Entry |
|-------|-------|
| 10:17 | Brainstorming session on the brief: question storming, reversing assumptions in the acceptance criteria, worst-possible-idea, Disney method for Part 2. |
| 11:06 | Brainstorm closed. Decisions: a bitemporal two-column report, suspense handling for Auth-Z, integer minor units, and fees idempotent per (account, value day). Still open: what happens to Auth-A's leftover hold, the fee/interest order, replay order, rounding mode, and the back-value window N. |
| 11:12 | Checked the toolchain. There is no Python on this machine. Node 24 is available, so I chose JS with BigInt minor units and `node:test` (zero dependencies, runs anywhere Node runs). |
| 11:16 | `git init`. Scaffolded `package.json` and `src/money.js` (parse, format, half-even division, exact split). |
| 11:19 | `node --test test/` failed: Node treated the directory argument as a single file and reported one failure with no useful detail. I switched the scripts to glob patterns, which need Node 21 or later. Money tests are green (5/5). |
