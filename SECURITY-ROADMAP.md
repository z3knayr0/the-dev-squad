# Security Roadmap

This document is the implementation plan for moving The Dev Squad from "guardrails around a supervisor-led dev team" toward stronger user protection.

The current hook-based model is useful, but it is not a security boundary against an adversarial agent. The path forward is phased:

1. `v0.3` — strict mode for Bash
2. `v0.4` — sandboxed agent execution
3. `v0.5` — host-owned policy and approval service

## Current Baseline

- Fast mode is the default execution mode and is optimized for speed.
- `pipeline/.claude/hooks/approval-gate.sh` constrains tool use, but it lives in an agent-writable tree and cannot fully control team members that still have Bash.
- `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` mitigates `cd`-then-`Write` drift, but it does not make Bash read-only.
- Remaining known gaps are documented in [SECURITY.md](SECURITY.md): Bash-mediated writes, indirect execution, hardlinks, TOCTOU, and accepted planning/review web egress.

## Target Modes

| Mode | Goal | User Experience | Residual Risk |
|------|------|-----------------|---------------|
| **Fast** | Keep the current autonomous workflow | Safe Bash stays automatic, obviously dangerous Bash asks for approval | Guardrails only, not strong containment |
| **Strict** | Put a human in the loop for all coder/tester Bash | Every Bash call from the Coder and Tester requires approval | Better practical safety, but still not a true sandbox |
| **Isolated** | Stronger containment for hostile or jailbreak-prone agents | Agents run inside per-project sandboxes with limited mounts and network | Much stronger, but still depends on the sandbox design and approval policy |

## Phase `v0.3`: Strict Mode

### Goal

Make coder/tester Bash usage human-mediated instead of pattern-mediated.

### Status

Shipped in `v0.3.0`:

- Pipeline runs can now choose `Fast` or `Strict`
- Strict mode asks for approval on every coder/tester Bash call
- The selected mode is persisted in pipeline state and passed through spawned sessions
- Approval decisions are tied to explicit request records instead of "latest project wins"
- Approved Bash commands receive a one-time grant for the exact command that was approved

Still pending inside `v0.3`:

- Improve the approval UI to show stronger request identity and history

### Why This Comes First

Strict mode closes the biggest day-to-day bypass class without forcing a container project first. It also fits the current product: the UI already has an approval surface, and the supervisor/team workflow already tracks project state.

### What Shipped in `v0.3`

- Visible security mode selector in the viewer for pipeline runs: `Fast` or `Strict`
- Selected mode persisted in pipeline state so the UI, orchestrator, and approvals agree on the current policy
- Strict-mode flag passed through all pipeline Claude spawn paths
- In strict mode, every Bash call from the Coder and Tester requires approval
- Approval UI shows the pending command, agent, cwd, and project
- Approval requests and decisions are logged into `pipeline-events.json`

### Key Files

- [src/app/page.tsx](/Users/johnknopf/Projects/the-dev-squad/src/app/page.tsx) — security mode control and clearer approval messaging
- [src/lib/use-pipeline.ts](/Users/johnknopf/Projects/the-dev-squad/src/lib/use-pipeline.ts) — include security mode in start requests and approval actions
- [src/app/api/start-pipeline/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/start-pipeline/route.ts) — persist selected mode into the project state and orchestrator launch
- [src/app/api/chat/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/chat/route.ts) — keep direct agent sessions aligned with the selected mode where applicable
- [pipeline/orchestrator.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/orchestrator.ts) — pass the mode through agent env/config and emit approval events
- [pipeline/.claude/hooks/approval-gate.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/.claude/hooks/approval-gate.sh) — treat coder/tester Bash as approval-gated in strict mode
- [src/app/api/pending/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/pending/route.ts) — stop relying on "latest project" and return explicit pending requests
- [src/app/api/approve/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/approve/route.ts) — approve a specific request, not whichever project updated last

### Remaining `v0.3.x` Polish

- Improve the approval UI to show stronger request identity and history

### Important Design Constraint

The current approval API finds the "latest project" by scanning `~/Builds/`. That is acceptable for today's single-run UX, but it is not a robust strict-mode foundation. Strict mode should key approvals by at least:

- `projectDir`
- `requestId`
- `agent`
- `command`
- `cwd`
- `createdAt`

### Acceptance Criteria

- In strict mode, the Coder and Tester never run Bash without a user decision
- Approval decisions are tied to an explicit request, not inferred from the newest project on disk
- The UI shows what is being approved before the command runs
- Denials are visible in the event log
- Fast mode behavior remains unchanged

## Phase `v0.4`: Sandboxed Agent Execution

### Goal

Move agent execution into an OS-enforced sandbox so Bash no longer has ambient access to the host filesystem.

### Concrete Spec

The implementation spec for this phase lives in [SANDBOX-RUNNER-PLAN.md](SANDBOX-RUNNER-PLAN.md).

### Deliverables

- Introduce a runner abstraction so the orchestrator and chat API stop spawning `claude` directly
- Run each team member inside a per-project container or equivalent sandbox
- Mount only the active project directory as writable
- Keep hooks, settings, and policy outside the project mount or mount them read-only
- Give each sandbox an ephemeral home directory instead of the host user's real home
- Add per-agent network profiles:
  - Planner: web access only if explicitly allowed
  - Coder/Tester: default-deny network unless a workflow needs it
  - Supervisor: broader access only if intentionally enabled

### Files To Change

- [pipeline/orchestrator.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/orchestrator.ts) — replace direct `claude` spawn with a sandbox runner
- [src/app/api/chat/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/chat/route.ts) — use the same runner for direct sessions
- [src/app/api/start-pipeline/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/start-pipeline/route.ts) — prepare per-project runtime metadata
- [pipeline/.claude/hooks/approval-gate.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/.claude/hooks/approval-gate.sh) — reduce its role once isolation exists

### Acceptance Criteria

- The Coder cannot write to a sibling build even with Bash redirection
- The Tester cannot write to project files unless policy explicitly permits it
- `.claude` policy files are no longer writable from inside agent execution environments
- Host files such as `~/.ssh`, shell profiles, and unrelated repos are not present inside the sandbox

## Phase `v0.5`: Host-Owned Policy Service

### Goal

Move trust out of the repo so protection does not depend on files the agent can edit, rename, or replace.

### Deliverables

- Replace repo-local policy ownership with a host-owned policy service or wrapper
- Store approvals, denials, and audit records outside the project directory
- Identify sessions and approvals by stable IDs instead of path scanning
- Keep a tamper-resistant audit log of:
  - command
  - cwd
  - agent
  - decision
  - timestamp
- Add an allowlisted execution path for common actions like install, build, and test so fewer tasks need raw Bash

### Files To Change

- [pipeline/orchestrator.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/orchestrator.ts) — delegate policy and approval state to the host-owned layer
- [src/app/api/pending/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/pending/route.ts) — read from a stable policy store
- [src/app/api/approve/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/approve/route.ts) — write decisions to the same store
- [pipeline/.claude/hooks/approval-gate.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/.claude/hooks/approval-gate.sh) — either shrink to a thin adapter or remove it from the trust boundary entirely

### Acceptance Criteria

- Renaming or deleting `.claude/` inside a project does not disable policy enforcement
- Approvals survive project rename/copy operations because they are not keyed by "latest project"
- A user can inspect approval history and active requests per project
- The repo can truthfully claim that the main enforcement boundary lives outside the agent-writable workspace

## Non-Goals

These are not realistic promises for the current hook architecture:

- Perfect protection with unrestricted Bash and no OS isolation
- Perfect detection of every indirect execution trick with grep or regexes
- Perfect human review of every command

## Recommended Next Step

Build `v0.4` next.

`v0.3` closed the most practical approval-flow gap. The next meaningful security improvement is sandboxed execution, because the major remaining risks now come from Bash authority and host filesystem access rather than missing approval plumbing.

Current `v0.4` status:

- the sandbox runner foundation and hybrid Docker worker path are in place
- Claude subscription auth for headless/container Claude Code is still an upstream blocker for fully isolated subscription-backed workers
- until that path works reliably, sandbox-eligible workers should fall back to host execution instead of hard-failing a run
