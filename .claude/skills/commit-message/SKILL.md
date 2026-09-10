# Generate Commit Message

Analyze staged changes and produce a single conventional-commit-formatted
message. This skill is deliberately usable in two different situations:

1. **Inside a freshly spawned agent with no prior context** (e.g. launched by
   the `commit` skill) — the message must be derived solely from
   `git diff --staged` and repo conventions, since there is nothing else to
   draw on.
2. **Directly inside an ongoing session** — the message may additionally draw
   on the session's own knowledge of *why* the change was made, as long as
   that rationale is actually evidenced by the conversation, not invented.

Do not assume which situation you're in beyond what you can observe: if you
have no memory of a preceding conversation, you're in situation 1.

## Steps

1. Run `git diff --staged` and `git status` to see exactly what's staged. If
   nothing is staged, stop and report that plainly — do not fabricate a
   message.
2. Run `git log --oneline -10` to match this repo's existing commit message
   conventions (tense, punctuation, use of scopes, etc.).
3. Check for project style guidance (e.g. `CLAUDE.md`, `docs/STYLE.md`) that
   might bear on how the change should be described.
4. If session context is available, use it only to explain *why* — never to
   describe changes not present in the diff.
5. Compose a conventional commit message:

   ```
   <type>(<scope>): <description>

   [optional body — short bullets on the "why", not a restatement of the diff]
   ```

## Types

`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

## Output contract

Output ONLY the raw commit message text as your final response — no
preamble, no code fences, no "Here's the message:", no trailing commentary.
A caller must be able to use your final response verbatim as the commit
message. Do not include an attribution/footer trailer — the caller adds any
trailer its own instructions require.
