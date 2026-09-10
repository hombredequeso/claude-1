# Git Commit Skill

Create a well-formatted git commit from staged changes. The commit message
is generated out-of-context by a subagent (so the main session's context
window isn't spent on `git diff` output), and the message is always
confirmed with the user before anything is committed.

## Usage
```
/commit
```

## Behavior

1. Run `git diff --staged --stat`. If nothing is staged, tell the user and
   stop — don't guess at what they meant to stage.
2. Launch a **fresh, context-free agent** (subagent_type: `general-purpose`
   — NOT `fork`, since a fork would inherit this session's context and
   defeat the purpose) with a prompt instructing it to:
   - Invoke the `commit-message` skill.
   - Work solely from `git diff --staged` and repo conventions — it has no
     access to this session's conversation.
   - Return only the generated commit message as its final answer.
3. Present the returned message to the user verbatim and ask them to
   approve, edit, or cancel. Do not commit yet.
4. On approval (as-is or with the user's edits):
   - Append any attribution/footer trailer that this session's own
     instructions require (the generation agent deliberately omits this).
   - Create the commit, passing the message via a heredoc so formatting is
     preserved:
     ```
     git commit -m "$(cat <<'EOF'
     <approved message>
     EOF
     )"
     ```
5. On cancellation, leave the staged changes untouched and stop.

## Notes

- Never skip step 3. The whole point of this skill is that the message is
  reviewed before it's used, even though a subagent wrote it.
- The `commit-message` skill can also be invoked on its own (e.g.
  `/commit-message`) directly in a session when you want the message to
  draw on session context in addition to the diff. This `/commit` flow
  intentionally avoids that path to keep messages diff-driven and cheap on
  context.
