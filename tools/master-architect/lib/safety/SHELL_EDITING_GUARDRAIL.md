# Shell-level Editing Guardrail — PLANNED, NOT IMPLEMENTED (RESTORE PRIOR BEHAVIOR)

## Status

**This existed before and was lost during a recent system upgrade.** Per user 2026-05-07: the old MCP server intercepted shell editing commands like `sed -i` and returned a refusal message ("sed is not available in this MCP server" or similar), pointing the LLM at the proper editor instead. Implementation was straightforward — pattern match the command at the run_cmd boundary, return the canned message instead of executing.

**First step before implementing:** find the historical implementation. Likely in:
- Git history of `server-modular.js` or earlier server variants
- `mcp_tools_backups/` directory
- Older `mcp_tools/run_cmd.js` versions

Reuse if findable. Fall back to spec below if not.

## Why

Shell tools like `sed -i`, `tee`, `> file`, `>> file`, `truncate` bypass read_file's verify+commit+undo lifecycle. When the LLM uses them for editing, the safety properties that make read_file trustworthy (verification gates, structural undo, atomic disk writes) are gone. The LLM falls back to "blind regex on text" which is exactly the failure mode read_file was built to prevent.

Observed in real session 2026-05-07: even when read_file was available, the LLM (myself) reached for `sed -i` for small edits out of shell habit. Worked fine that one time but the pattern is the foot-gun.

## What

Pattern-match commands at the run_cmd boundary. When a destructive editing pattern is detected, return a canned refusal message instead of executing.

Patterns to refuse:
- `sed -i` / `sed --in-place`
- `tee` writing to existing files
- `truncate -s` on existing files
- Redirects to existing files: `> /existing/file` or `>> /existing/file`
  (NEW files via redirect should still work — that's not editing)

Refusal message (something like):

> "sed is not available in this MCP server. Use read_file to edit /path/to/file."

Adapt the message per pattern (`tee`, `truncate`, etc. each get their own).

## Scope

Only refuse when the target is a file in a known project (architect tracks them). Outside any project = unrestricted, since the LLM might be doing legitimate shell scripting.

## What NOT to refuse

- Reading: `cat`, `head`, `tail`, `grep`, `awk` (when no `-i`)
- Inspecting: `file`, `stat`, `ls`, `wc`, `md5sum`, `sha256sum`
- Process management: `ps`, `kill`, `systemctl status`
- Network/system: `ping`, `df`, `free`, `dmesg`
- New file creation via redirect: `echo "..." > /new/file/that/does/not/exist`
- Anything inside /tmp or other scratch dirs

## Effort estimate

~30-45 minutes if reusing the historical pattern. ~1 hour from scratch.

## When to build

After bug_recorder lands (so refusal events can be recorded as a soft-failure category — useful signal about how often the LLM tries to bypass and what for).

Before customer launch — customers WILL try to do things that bypass the safety system, and the guardrail prevents the worst outcomes.

## Why NOT the redirect-to-sandbox approach

Earlier draft of this spec proposed redirecting `sed -i` to a sandbox copy so the LLM wouldn't realize the edit didn't take, then self-correcting via the next read. Per user clarification: the historical implementation was just the refusal message, not sandboxing.

The refusal message is better:
- Honest (no "you edited a file but didn't" deception moment)
- Simpler (pattern match → canned response, no sandbox dirs to manage)
- The LLM gets the right pointer immediately and can switch tools without needing a "read shows original content" round-trip
