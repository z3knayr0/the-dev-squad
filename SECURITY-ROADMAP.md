# Security Roadmap

This document is the implementation plan for moving The Dev Squad from "guardrails against accidental lane drift" toward stronger user protection.

The current hook-based model is useful, but it is not a security boundary against an adversarial agent. The path forward is phased:

1. `v0.3` — strict mode for Bash
2. `v0.4` — sandboxed agent execution
3. `v0.5` — host-owned policy and approval service

## Current Baseline

- Default pipeline mode is autonomous and optimized for speed.
- `pipeline/.claude/hooks/approval-gate.sh` constrains tool use, but it lives in an agent-writable tree and cannot fully control agents that still have Bash.
- `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` mitigates `cd`-then-`Write` drift, but it does not make Bash read-only.
- Remaining known gaps are documented in [SECURITY.md](SECURITY.md): Bash-mediated writes, indirect execution, hardlinks, TOCTOU, and accepted `WebSearch` egress for A.

## Target Modes

| Mode | Goal | User Experience | Residual Risk |
|------|------|-----------------|---------------|
| **Fast** | Keep the current autonomous workflow | Safe Bash stays automatic, obviously dangerous Bash asks for approval | Guardrails only, not strong containment |
| **Strict** | Put a human in the loop for all C/D Bash | Every Bash call from C and D requires approval | Better practical safety, but still not a true sandbox |
| **Isolated** | Stronger containment for hostile or jailbreak-prone agents | Agents run inside per-project sandboxes with limited mounts and network | Much stronger, but still depends on the sandbox design and approval policy |

## Phase `v0.3`: Strict Mode

### Goal

Make agent C and D Bash usage human-mediated instead of pattern-mediated.

### Status

First cut shipped:

- Pipeline runs can now choose `Fast` or `Strict`
- Strict mode asks for approval on every C/D Bash call
- The selected mode is persisted in pipeline state and passed through spawned sessions

Still pending inside `v0.3`:

- Move approvals from "latest project on disk" to explicit request-scoped records
- Improve the approval UI to show stronger request identity and history

### Why This Comes First

Strict mode closes the biggest day-to-day bypass class without forcing a container project first. It also fits the current product: the UI already has an approval surface, and the orchestrator already tracks project state.

### Deliverables

- Add a visible security mode selector in the viewer for pipeline runs: `Fast` or `Strict`
- Persist the selected mode in pipeline state so the UI, orchestrator, and approvals all agree on the current policy
- Pass a strict-mode flag through all pipeline Claude spawn paths
- In strict mode, require approval for every Bash call from agents C and D
- Show the full pending command, agent, cwd, and project in the approval UI
- Log approval requests and decisions into `pipeline-events.json`

### Files To Change

- [src/app/page.tsx](/Users/johnknopf/Projects/the-dev-squad/src/app/page.tsx) — security mode control and clearer approval messaging
- [src/lib/use-pipeline.ts](/Users/johnknopf/Projects/the-dev-squad/src/lib/use-pipeline.ts) — include security mode in start requests and approval actions
- [src/app/api/start-pipeline/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/start-pipeline/route.ts) — persist selected mode into the project state and orchestrator launch
- [src/app/api/chat/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/chat/route.ts) — keep direct agent sessions aligned with the selected mode where applicable
- [pipeline/orchestrator.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/orchestrator.ts) — pass the mode through agent env/config and emit approval events
- [pipeline/.claude/hooks/approval-gate.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/.claude/hooks/approval-gate.sh) — treat C/D Bash as approval-gated in strict mode
- [src/app/api/pending/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/pending/route.ts) — stop relying on "latest project" and return explicit pending requests
- [src/app/api/approve/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/approve/route.ts) — approve a specific request, not whichever project updated last

### Important Design Constraint

The current approval API finds the "latest project" by scanning `~/Builds/`. That is acceptable for today's single-run UX, but it is not a robust strict-mode foundation. Strict mode should key approvals by at least:

- `projectDir`
- `requestId`
- `agent`
- `command`
- `cwd`
- `createdAt`

### Acceptance Criteria

- In strict mode, C and D never run Bash without a user decision
- Approval decisions are tied to an explicit request, not inferred from the newest project on disk
- The UI shows what is being approved before the command runs
- Denials are visible in the event log
- Fast mode behavior remains unchanged

## Phase `v0.4`: Sandboxed Agent Execution

### Goal

Move agent execution into an OS-enforced sandbox so Bash no longer has ambient access to the host filesystem.

### Deliverables

- Introduce a runner abstraction so the orchestrator and chat API stop spawning `claude` directly
- Run each pipeline agent inside a per-project container or equivalent sandbox
- Mount only the active project directory as writable
- Keep hooks, settings, and policy outside the project mount or mount them read-only
- Give each sandbox an ephemeral home directory instead of the host user's real home
- Add per-agent network profiles:
  - A: web access only if explicitly allowed
  - C/D: default-deny network unless a workflow needs it
  - S: broader access only if intentionally enabled

### Files To Change

- [pipeline/orchestrator.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/orchestrator.ts) — replace direct `claude` spawn with a sandbox runner
- [src/app/api/chat/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/chat/route.ts) — use the same runner for direct sessions
- [src/app/api/start-pipeline/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/start-pipeline/route.ts) — prepare per-project runtime metadata
- [pipeline/.claude/hooks/approval-gate.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/.claude/hooks/approval-gate.sh) — reduce its role once isolation exists

### Acceptance Criteria

- Agent C cannot write to a sibling build even with Bash redirection
- Agent D cannot write to project files unless policy explicitly permits it
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

Build `v0.3` first.

It is the smallest change that materially improves safety, it uses infrastructure the app already exposes, and it creates the approval model that the later sandbox and policy phases can reuse.
