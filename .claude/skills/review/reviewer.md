# Reviewer instructions

You are reviewing a code change for real bugs and for code-quality regressions. You have no access to
the session that launched you; everything you need is in the repo and in the review target you were
given.

## 1. Resolve what to review

Work out a **base** commit, a **head** (a commit, or the working tree), and an optional **path**
filter from the review target:

| Target | base | head |
| --- | --- | --- |
| none / `default` | `git merge-base @{upstream} HEAD` (or `git merge-base main HEAD` if there's no upstream) | working tree — committed, staged, unstaged and untracked changes |
| a branch name `<b>` | `git merge-base main <b>` | `<b>` |
| a PR number `<n>` | `gh pr view <n> --json baseRefName,headRefOid`, then `git fetch origin <baseRefName> pull/<n>/head`, base = `git merge-base origin/<baseRefName> <headRefOid>` | `<headRefOid>` |
| a file or directory path `<p>` | as for none | working tree, with path filter `<p>` |

Don't create or switch branches, and don't stash or otherwise modify the working tree.

## 2. Gather the diff and the tool results — in parallel

In a **single message**, make these two Bash calls so they run concurrently:

- The quality script (it takes ~20s; give it a 300000ms timeout):
  `node .claude/skills/review/scripts/review-quality.mjs --base <base> [--head <head>] [--path <p>]`
- The diff: `git diff <base>` for the working tree (plus `git ls-files --others --exclude-standard`
  to list untracked files, which you then read), or `git diff <base> <head>` for a commit; restrict
  to `-- <p>` if there's a path filter.

If the diff is empty and there are no untracked files, stop and reply that there is nothing to review
for that target.

The script checks the base and the head with the repo's lint, depcruise, knip, tsc, vitest, FTA and
per-function cyclomatic complexity tools, and prints JSON containing **only what the change
introduced**. If it prints `"kind": "error"`, report that the quality checks couldn't run (with its
message) and carry on with the correctness review.

## 3. Correctness review

Review the diff as a careful senior engineer would: read every hunk, open the surrounding files for
context as needed (Read, Grep, git log/blame/show), and hunt for correctness issues — wrong or
inverted conditions, off-by-one, null/undefined dereference, missing `await`, dropped error handling,
removed guards or validations, broken callers of changed functions, races. Prefer real failure modes
over style; every finding needs a concrete scenario in which the code misbehaves.

Report at most 15 correctness findings. Quality over quantity: include everything you genuinely
believe is a real issue, and nothing you don't.

## 4. Code-quality review, from the script's JSON

Each entry under `checks` is either `{"kind": "error", "message"}` (that tool couldn't run on the
change — say so in the tool summary) or `{"kind": "ok", "baseline", ...}`. If `baseline` is
`unavailable: ...`, the tool couldn't run on the base commit, so everything it reports was counted as
introduced — say so, and use judgement about which items the change actually caused.

Turn the results into findings:

- **`tests.introduced`, `typecheck.introduced`** — each failing test and each type error is a finding.
  These outrank everything else.
- **`complexity.newFunctionsOverLimit`** — a new function whose cyclomatic complexity is over the
  limit. Name the function, give its complexity, and point at what drives it (the branches/conditions)
  and how it could be split or simplified.
- **`complexity.markedIncreases`** — a changed function whose complexity rose markedly. Give before →
  after, say which part of the change added the branching, and whether it is justified.
- **`fta.worsenedFiles`** — a changed file whose FTA (maintainability) score got notably worse or
  moved to a worse band, or a new file not rated OK. Give before → after score and band, and the
  likely cause.
- **`lint.introduced`, `depcruise.introduced`, `knip.introduced`** — new lint errors/warnings,
  architecture-rule violations, and unused files/exports/dependencies. Group repeats of the same
  problem into one finding. A lint `complexity` warning for a function already reported under
  `complexity` is not a separate finding.

Don't re-report pre-existing problems — the script has already excluded them.

## 5. Reply

Reply with exactly these two sections and nothing else.

```
## Findings

1. <file>:<line> — <one-sentence statement of the problem>
   - Category: correctness | tests | typecheck | complexity | fta | lint | depcruise | knip
   - Scenario: <concrete inputs/state → wrong output/crash; for quality findings, the numbers and why it matters>

(or "No findings.")

## Quality tools

| Check | Result |
| --- | --- |
| lint | <n new issues / none / couldn't run: reason> |
| depcruise | ... |
| knip | ... |
| typecheck (tsc) | ... |
| tests (vitest) | ... |
| complexity (per function) | ... |
| FTA (per file) | ... |

<one line noting any baseline caveats; omit if none>
```

Order findings most severe first: failing tests and type errors, then correctness bugs, then
quality findings.
