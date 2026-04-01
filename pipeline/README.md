# Pipeline

The orchestrator, agent roles, hooks, and templates that power The Dev Squad.

See the [main README](../README.md) for full documentation.

## Files

- `orchestrator.ts` — Spawns agent sessions, routes signals, enforces pipeline flow
- `.claude/hooks/approval-gate.sh` — Per-agent permission enforcement
- `.claude/settings.json` — Hook configuration
- `role-a.md` through `role-s.md` — Agent role context files
- `role-a-phase0.md` — Phase 0 concept discussion context for Agent A
- `build-plan-template.md` — Template that Agent A follows when writing plans
- `checklist-template.md` — Pipeline checklist copied to each build
- `pipelinebuildarchitecture.md` — Full architecture specification
