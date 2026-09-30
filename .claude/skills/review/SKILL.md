---
name: review
description: Review a code change (branch vs upstream plus uncommitted work by default, or a named branch, PR number or path) for correctness bugs, and for regressions reported by this repo's quality tools — lint, depcruise, knip, tsc, tests, FTA file scores and per-function cyclomatic complexity. Only problems the change introduces are reported.
---

# Review

Reviews a code change for real bugs, and runs the repo's code-quality tools against both the base
and the change so it can report what the change made worse: new lint/depcruise/knip problems, type
errors, failing tests, new functions over the complexity limit, changed functions whose complexity
rose markedly, and files whose FTA score got worse.

## Usage

```
/review              # current branch vs its upstream (or main), plus staged, unstaged and untracked changes
/review <branch>     # that branch vs main
/review <pr-number>  # a GitHub PR
/review <path>       # the default change, limited to a file or directory
```

## Behavior

1. Launch a **fresh, context-free agent** (subagent_type: `general-purpose` — NOT `fork`, so the
   review isn't shaped by this session's conversation and the diff and tool output don't land in
   this session's context). Don't pass `model`; the reviewer uses the session's model. Prompt:

   > Read `.claude/skills/review/reviewer.md` in the repository at `<repo root>` and follow it exactly.
   > Review target: `<the /review arguments, or "default" if none>`.

2. When the agent returns, relay its report:
   - If the `ReportFindings` tool is available, call it once with the findings from the report's
     **Findings** section (file, line, summary, failure scenario, category; most severe first; an
     empty array for "No findings."), then print only the **Quality tools** section as text.
   - Otherwise print the whole report.

## Files

- `reviewer.md` — the reviewing agent's instructions (target resolution, correctness review, how to
  turn tool results into findings, reply format).
- `scripts/review-quality.mjs` — runs the quality checks on the base and on the change, in parallel,
  and prints only what the change introduced, as JSON. It checks the base out into a temporary git
  worktree (linked to the existing `node_modules`), so the working tree is never touched. Thresholds
  are constants at the top of the script:
  - a function with cyclomatic complexity **over 8** is over the limit
  - a **marked increase** is +3 or more, +50% or more, or crossing the limit
  - an FTA score is **worse** if it rises 10% or more, drops to a worse band, or a new file isn't
    rated OK
