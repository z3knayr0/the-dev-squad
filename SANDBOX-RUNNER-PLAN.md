# v0.4 Sandbox Runner Plan

This document is the concrete implementation plan for `v0.4`: moving The Dev Squad from direct host Claude spawning to sandboxed team execution.

It is intentionally specific. The goal is to give the Supervisor the same dev team experience while changing the execution boundary underneath it.

## Why This Exists

`v0.3.x` made the product feel like "Claude with its own dev team":

- the Supervisor can manage the team
- the Planner, Plan Reviewer, Coder, and Tester can keep context in one place
- strict mode and recovery are meaningfully better

But the current execution model is still host-native:

- the orchestrator spawns `claude` directly on the host
- the chat API does the same
- hook files live inside the project tree
- Bash-capable agents still rely on guardrails, not containment

That is good enough for `v0.3.x`. It is not the final boundary.

`v0.4` is where containment gets stronger.

## Product Goal

Keep the current product feel:

- the Supervisor is still the front door
- the team still follows the same doctrine
- fast and strict workflows still work
- direct specialist chat still exists

Change the execution model underneath it:

- team members run through a runner abstraction
- the default "isolated" path uses per-project containers
- hooks and settings are mounted read-only
- host home directories and sibling builds are not visible inside team execution environments

## Current State

Today the main spawn paths are:

- [pipeline/orchestrator.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/orchestrator.ts)
- [src/app/api/chat/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/chat/route.ts)

Both still launch `claude` directly on the host.

Today the main guardrail is:

- [pipeline/.claude/hooks/approval-gate.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/.claude/hooks/approval-gate.sh)

That hook is useful, but it is not a security boundary against a hostile or jailbreak-prone agent. It cannot fully solve:

- Bash-mediated writes
- indirect execution
- hardlink aliasing
- TOCTOU gaps
- hook files living inside the project tree

## Design Goals

1. Add one runner interface for all Claude spawn paths.
2. Preserve the current streaming interface and session behavior.
3. Limit each team member to the active project only.
4. Keep hook and settings files read-only from the agent perspective.
5. Narrow network access by role.
6. Fall back gracefully to host execution when sandboxing is unavailable.

Current practical note:

- the Docker worker path exists now
- Claude subscription auth inside headless/container Claude Code is still flaky in practice
- when isolated auth is unavailable, the current implementation should retry that turn on the host instead of failing the whole run

## Team Mapping

The sandbox design is role-first:

| Role | Internal ID | Main Need |
|------|-------------|-----------|
| Supervisor | `S` | Control-plane UX and recovery, not part of the initial sandbox requirement |
| Planner | `A` | Read/write `plan.md`, research access |
| Plan Reviewer | `B` | Read-only project access, research access |
| Coder | `C` | Project write access, package/build network access |
| Tester | `D` | Project access for install/test workflows, package/build network access |

`v0.4` is primarily about sandboxing the worker team. The Supervisor remains a product/control concept first and does not need to be the first sandbox target.

## Runner Abstraction

Create:

- [pipeline/runner.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/runner.ts)

The runner layer should expose:

- a shared `RunnerOptions` type
- a `Runner` interface
- `HostRunner`
- `DockerRunner`
- a small factory such as `createRunner()`

Required rule:

- no code outside `runner.ts` should call `spawn('claude', ...)` directly once Phase 1 lands

Primary consumers:

- [pipeline/orchestrator.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/orchestrator.ts)
- [src/app/api/chat/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/chat/route.ts)

## Execution Modes

The runner should support:

| Mode | Meaning |
|------|---------|
| `host` | Current behavior, no sandbox |
| `docker` | Require containerized execution |
| `auto` | Prefer Docker, fall back to host with warning |

Environment variable:

- `PIPELINE_RUNNER=host|docker|auto`

## Hybrid Rollout Note

The initial reviewed plan included a phased rollout where Coder/Tester move first and Planner/Reviewer follow later.

That is still the right rollout, but it means the implementation should support hybrid selection during rollout:

- Planner + Plan Reviewer may stay on `HostRunner`
- Coder + Tester may use `DockerRunner`

So the runner factory should be designed to support per-agent selection during `v0.4.0-beta`, even if the long-term interface still looks simple from the outside.

## Container Model

Use Docker-compatible containers:

- Docker Desktop
- OrbStack
- Colima-compatible Docker CLI environments

Why Docker:

- available now
- cross-platform enough for the current project direction
- mature bind mounts and named volumes
- supports the exact read-only overlay behavior we need

## Container Image

Create:

- [pipeline/Dockerfile.agent](/Users/johnknopf/Projects/the-dev-squad/pipeline/Dockerfile.agent)
- [pipeline/agent-entrypoint.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/agent-entrypoint.sh)
- [pipeline/agent-firewall.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/agent-firewall.sh)

Base requirements:

- Node-based image with Claude Code installed
- `jq` available for hook logic
- firewall tooling available for per-role network profiles
- non-root default user
- ephemeral container lifecycle

## Filesystem Layout

Inside the container, the active project should be mounted at:

- `/home/node/Builds/<project-name>`

That path is intentional so the current hook's `$HOME/Builds/` checks keep working during transition.

Read-only overlay mounts:

- `pipeline/.claude/hooks/` -> `<project>/.claude/hooks/`
- `pipeline/.claude/settings.json` -> `<project>/.claude/settings.json`

Read-only doctrine mounts as needed:

- role file
- build plan template
- checklist template

Session persistence:

- named volume mounted at `/home/node/.claude`

Critical security improvement:

- hooks/settings are no longer writable from inside the worker's project mount even if the worker has Bash

## Project Access Matrix

| Role | Project Mount |
|------|---------------|
| Planner | `rw` |
| Plan Reviewer | `ro` |
| Coder | `rw` |
| Tester | `rw` |

Why Tester is `rw`:

- test/install workflows commonly need filesystem writes
- this does not worsen the already-accepted Bash posture relative to `v0.3.x`
- the real `v0.4` gain is containment to the active project and host isolation

Hook-based file-tool restrictions remain as defense in depth.

## Network Profiles

Use role-based network profiles:

| Role | Profile | Intent |
|------|---------|--------|
| Planner | `research` | Web research and docs |
| Plan Reviewer | `research` | Verification and direct-source review |
| Coder | `build` | Package registries, GitHub, Claude API |
| Tester | `build` | Package registries, GitHub, Claude API |

Important implementation note:

- the `build` profile should be treated as pragmatic, not perfect
- CDN-backed registries make strict IP/domain allowlisting brittle
- if the `build` profile proves too fragile in practice, widen it deliberately rather than pretending the allowlist is perfect

## Environment Handling

Pass only explicit environment variables into containers.

Forward:

- `ANTHROPIC_API_KEY`
- `PIPELINE_AGENT`
- `PIPELINE_SECURITY_MODE`
- `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`
- role-specific network profile variables

Do not forward:

- ambient host `process.env`
- unrelated credentials
- shell profile state

## Approval And Resume Behavior

The existing strict-mode behavior should continue to work through the runner abstraction:

1. worker runs inside container
2. hook returns `ask`
3. Claude emits the same stream-json approval event
4. orchestrator records pending approval
5. user approves or denies
6. orchestrator resumes the same worker session
7. one-time grant file is consumed from the mounted project directory

The key rule is:

- the streaming protocol must stay unchanged from the orchestrator's perspective

If the line-by-line event handling changes, the migration becomes much riskier than it needs to be.

## Rollout Phases

### Phase 1: Runner Abstraction

Goal:

- introduce `runner.ts`
- route orchestrator and chat spawn paths through it
- keep behavior identical with `HostRunner`

This is the first coding phase.

Acceptance criteria:

- existing flows behave the same
- streaming parsing logic stays intact
- no direct `spawn('claude', ...)` remains outside `runner.ts`

### Phase 2: Coder And Tester Sandboxed First

Goal:

- move the highest-risk worker roles into containers first

Acceptance criteria:

- Coder cannot reach sibling builds
- Tester cannot reach sibling builds
- neither can reach host home files
- hooks/settings are read-only inside their execution environment
- strict approvals still work

### Phase 3: Planner And Plan Reviewer Sandboxed

Goal:

- bring research/review roles into the same container model

Acceptance criteria:

- Planner can still write `plan.md`
- Plan Reviewer stays read-only
- direct-source research still works
- plan/review flow behaves the same from the UI's perspective

### Phase 4: Hook Reduction

Goal:

- simplify the hook once the container boundary is doing the heavy lifting

Keep in hook:

- role-based tool policy
- plan lock
- phase gating
- strict approval checks
- recursive agent blocking

Reduce:

- enforcement already guaranteed by mounts or runner-level isolation

## Files To Create

- [pipeline/runner.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/runner.ts)
- [pipeline/Dockerfile.agent](/Users/johnknopf/Projects/the-dev-squad/pipeline/Dockerfile.agent)
- [pipeline/agent-entrypoint.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/agent-entrypoint.sh)
- [pipeline/agent-firewall.sh](/Users/johnknopf/Projects/the-dev-squad/pipeline/agent-firewall.sh)

## Files To Modify

- [pipeline/orchestrator.ts](/Users/johnknopf/Projects/the-dev-squad/pipeline/orchestrator.ts)
- [src/app/api/chat/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/chat/route.ts)
- [SECURITY.md](/Users/johnknopf/Projects/the-dev-squad/SECURITY.md)
- [SECURITY-ROADMAP.md](/Users/johnknopf/Projects/the-dev-squad/SECURITY-ROADMAP.md)
- [ARCHITECTURE.md](/Users/johnknopf/Projects/the-dev-squad/ARCHITECTURE.md)

Optional transition update:

- [src/app/api/start-pipeline/route.ts](/Users/johnknopf/Projects/the-dev-squad/src/app/api/start-pipeline/route.ts) can keep copying hook files for host compatibility during rollout

## Failure Modes To Plan For

- Docker not installed
- Docker daemon not running
- image not built
- registry/network allowlist too narrow
- session volume corruption
- missing `ANTHROPIC_API_KEY`
- read-only mounts blocking expected writes
- container startup latency

The product response should stay graceful:

- `auto` mode falls back to host with a warning
- `docker` mode fails clearly
- failures should read like supervisor/operator guidance, not just raw infra errors

## Architecture Rules

1. The runner interface becomes the only Claude spawn path.
2. Host runner stays available as an escape hatch.
3. The sandbox is the primary containment boundary, not the hook.
4. One container per worker turn is acceptable; session state persists separately.
5. Team UX must not regress just because isolation got stronger.

## Recommendation

Use this document as the working `v0.4` implementation spec.

Immediate next build step:

1. implement Phase 1 only
2. ship the runner abstraction with `HostRunner`
3. keep user-facing behavior unchanged
4. then layer Docker execution in behind the same interface
