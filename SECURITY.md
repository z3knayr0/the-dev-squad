# Security

## Hook Enforcement Model

Agent permissions are enforced by a `PreToolUse` hook (`pipeline/.claude/hooks/approval-gate.sh`), not by prompts. The hook runs before every tool call for every agent. It is the only security boundary — prompts provide context, the hook provides law.

## Hardened in v0.2.3

A security audit identified 10 vulnerabilities in the original hook script. All have been fixed.

### Critical — Fixed

**V1: Hook overwrite via Bash**
Agents C and D had Bash access and could overwrite the hook script itself since it lives inside `~/Builds/`. A simple `echo > .claude/hooks/approval-gate.sh` would disable all restrictions.

*Fix:* Bash commands containing `.claude/`, `settings.json`, or `approval-gate` are now blocked.

**V2: Hook overwrite via Write/Edit**
Agent C could use the Write tool to replace `approval-gate.sh` or `settings.json` since the `.claude/` directory is inside the project folder and wasn't explicitly protected.

*Fix:* All writes to `/.claude/` paths are blocked for ALL agents, including S.

**V3: Agent escalation via Bash**
Agents C and D could spawn a new Claude session with `PIPELINE_AGENT=S` via Bash, gaining unrestricted Supervisor access.

*Fix:* Bash commands containing `PIPELINE_AGENT`, `claude -p`, or `claude --` are blocked.

**V4: Symlink bypass**
Agent C could create a symlink inside `~/Builds/` pointing to an external file, then write to the symlink. The hook only resolved directory symlinks, not file-level symlinks.

*Fix:* File paths are now resolved with `readlink -f` before the prefix check. The actual target is validated, not the symlink.

### High — Fixed

**V5: NotebookEdit bypass**
The `NotebookEdit` tool was not gated by the Write/Edit case, falling through to the catch-all allow. Any agent — including read-only agents B and D — could modify `.ipynb` files.

*Fix:* `NotebookEdit` is now handled alongside Write/Edit with the same restrictions.

**V6: Missing trailing slash in prefix check**
The builds directory check used `"$BUILDS_DIR"*` without a trailing slash, so a path like `~/Builds-evil/payload.sh` would pass the prefix check.

*Fix:* Changed to `"$BUILDS_DIR/"*` — requires the path to be inside the directory, not just starting with the same prefix.

**V7: Unknown agent identity**
If `PIPELINE_AGENT` was unset or set to an unrecognized value, the agent identity defaulted to "unknown" which bypassed most restrictions.

*Fix:* Unknown agent identities are immediately rejected. Only A, B, C, D, and S are valid.

### Medium — Fixed

**V8: Data exfiltration via WebFetch**
`WebFetch` was ungated — any agent could POST source code or secrets to an external URL. `WebSearch` was also ungated but is lower risk.

*Fix:* `WebFetch` is blocked for all agents. `WebSearch` is added to the read-only allow list (research is legitimate, exfiltration via search queries is impractical).

**V9: jq parse failure fallthrough**
If the JSON input was malformed and `jq` returned empty, the tool name would be empty and fall through to the catch-all allow.

*Fix:* Empty or null tool names are rejected immediately before any other processing.

### Low — Fixed

**V10: Path traversal via `..` components**
The path resolution fallback preserved `..` components when the target directory didn't exist, potentially bypassing the prefix check.

*Fix:* Paths containing `..` are rejected outright before resolution.

## Design Changes

**Deny by default.** The catch-all at the bottom of the hook now blocks unrecognized tools instead of allowing them. This means any future tool added to Claude Code is blocked until explicitly allowed, preventing a class of bypass via new tools.

**Agent S restricted.** S was previously fully unrestricted. S can now read anything (for diagnostics) and run Bash, but writes are jailed to `~/Builds/` and `.claude/` paths are blocked. S cannot modify the hook or settings.

**Agent tool blocked for all agents.** Previously only blocked for A-D. Now blocked for S as well — no agent can spawn sub-agents.

## Current Permission Matrix

| Agent | Read | Write | Bash | WebSearch | WebFetch | Agent Tool |
|-------|------|-------|------|-----------|----------|------------|
| S | Anywhere | `~/Builds/` only (no `.claude/`) | Yes (no `claude` spawn, no `.claude/` modification, no `ln`) | No | No | No |
| A | Anywhere | `plan.md` only (no Phase 0) | No | Yes (A only) | No | No |
| B | Anywhere | No | No | No | No | No |
| C | Anywhere | `~/Builds/` (no `plan.md`, no `.claude/`) | Yes (restricted, no `ln`) | No | No | No |
| D | Anywhere | No | Yes (restricted, no `ln`) | No | No | No |

## Known Limitations

This hook prevents agents from **accidentally** exceeding their role. It is NOT a security sandbox.

**Indirect execution bypass:** An agent with Bash access (C, D, S) could theoretically use `python3 -c`, `eval`, or base64 encoding to indirectly invoke Claude or modify files in ways the grep filters don't catch. The hook blocks direct invocations but cannot prevent all forms of indirect execution.

**TOCTOU race conditions:** The hook resolves file paths at check time. Between the check and the actual tool execution, symlinks could be retargeted. This is a fundamental limitation of check-then-act in a separate process.

**Hardlink detection:** The hook resolves symlinks via `readlink -f` and blocks `ln` commands, but cannot detect pre-existing hardlinks created outside the hook's observation.

For true isolation, use OS-level sandboxing (containers, chroot, seccomp). The hook is a guardrail, not a jail.

## Reporting

If you find a security issue, please open a private issue or contact the maintainer directly.
