# Architecture

5 agents. Two modes. In **Pipeline Mode**, agents pass work back and forth autonomously until it's perfect. In **Manual Mode**, you are the orchestrator — 5 Claude sessions with expertise labels, no automation, you direct everything.

## The Agents

- **S — Supervisor**: Assists the user in overseeing the pipeline. Reads everything. Diagnoses issues. Not part of the autonomous flow — available on demand.
- **A — Planner**: Chats with the user, researches, writes the build plan, deploys at the end
- **B — Plan Reviewer**: Pokes holes in the plan until there are none left
- **C — Coder**: Follows the approved plan and writes the code
- **D — Code Reviewer + Tester**: Reviews the code against the plan, then tests it

## The Flow

### Phase 0: Concept

1. The **user** chats with **A** in the viewer. This is the only required human interaction.
2. **A** asks clarifying questions — what do you want, how should it work, any constraints?
3. Chat happens in a staging area (`~/Builds/.staging/`). No project directory created yet.
4. When the user hits **START**, staging moves to a real project dir and the pipeline runs autonomously.

### Phase 1: Planning

5. **A** reads `build-plan-template.md` — A's playbook.
6. **A** completes the entire checklist — research, write, verify, context, review.
7. **A** writes the plan to `plan.md` with complete, copy-pasteable code for every file.
8. **A** self-reviews multiple times before sending to B.

### Phase 1b: Plan Review

9. **B** reads the plan and sends structured questions back to **A**.
10. **A** answers with verified information and updates the plan.
11. This loops until **B** is fully satisfied. No round limit.
12. **B** approves. The plan is locked — no agent can modify it from this point.

### Phase 2: Coding

13. **C** reads the locked plan and builds exactly what it says.
14. No improvising, no interpreting, no "improving."

### Phase 3: Code Review

15. **D** reads the plan and the code. Checks: does the code match the plan?
16. If **D** has issues, sends them to **C**. **C** fixes, sends back.
17. Loops until **D** is satisfied with the code.

### Phase 4: Testing

18. **D** runs the code. Tests it.
19. If tests fail, **D** sends failures to **C**. **C** fixes, **D** tests again.
20. Loops until all tests pass.

### Phase 5: Deploy

21. Build complete. Project is in `~/Builds/<project-name>/`.

## Enforcement: Scripts, Not Prompts

LLMs ignore prompt instructions. An agent told "only write plan.md" will write code files. An agent told "don't modify anything" will edit the plan.

Restrictions are enforced by a `PreToolUse` hook (`pipeline/.claude/hooks/approval-gate.sh`) that prevents agents from accidentally exceeding their role. The hook is a guardrail, not a sandbox — see [SECURITY.md](../SECURITY.md) for the threat model and known limitations. The hook reads the `PIPELINE_AGENT` environment variable and gates every tool call:

| Agent | Write | Bash | Agent Tool |
|-------|-------|------|------------|
| **A** (Planner) | `plan.md` only | Blocked | Blocked |
| **B** (Reviewer) | Blocked | Blocked | Blocked |
| **C** (Coder) | Inside `~/Builds/` (except plan.md) | Safe=auto, dangerous=approval | Blocked |
| **D** (Tester) | Blocked | Safe=auto, dangerous=approval | Blocked |
| **S** (Supervisor) | `~/Builds/` only (no `.claude/`) | Yes (restricted) | Blocked |

Additional protections:
- All writes outside `~/Builds/` are blocked for every agent
- Plan is locked after B approves
- Agent tool blocked for all agents (prevents recursive spawning)
- `--permission-mode auto` adds Claude's AI safety classifier on top

## Agent Communication

Agents don't parse free text. They communicate via structured JSON schemas:

```json
// B reviewing A's plan
{ "status": "approved" }
{ "status": "questions", "questions": ["What about error handling?"] }

// D reviewing C's code
{ "status": "approved" }
{ "status": "issues", "issues": ["Missing input validation on POST /users"] }

// D testing C's code
{ "status": "passed" }
{ "status": "failed", "failures": ["PUT /users returns 500 on empty body"] }
```

The orchestrator routes these signals and uses `isPositiveSignal()` to normalize approval variants.

## Session Spawning

Each agent runs as a separate Claude Code session:

```bash
claude -p "<prompt>" \
  --system-prompt-file <role-file> \
  --permission-mode auto \
  --model claude-opus-4-6 \
  --output-format stream-json \
  --verbose
```

- `--permission-mode auto` — Claude's AI classifier handles general safety
- `--output-format stream-json` — real-time streaming for the viewer
- `PIPELINE_AGENT` env var — tells the hook which agent is running
- Role files provide context (what the agent's job is), hooks provide law (what the agent can do)

## The Orchestrator

`pipeline/orchestrator.ts` is deterministic code, not an LLM. It:

1. Spawns agent sessions in order
2. Parses their streaming JSON output
3. Routes structured signals between agents
4. Advances the pipeline phase on approval signals
5. Tracks token usage, costs, and events
6. Writes everything to `pipeline-events.json` for the viewer

The orchestrator cannot be confused, distracted, or convinced to skip steps.

## The Viewer

A Next.js app that polls `pipeline-events.json` every 400ms and renders:

- Pixel art office scene with 5 agents at desks
- Live feed of all events
- 5-panel grid (S + A/B/C/D) with per-agent event streams
- Dashboard with phase progress, token usage, cost
- Per-panel chat inputs for direct agent communication
- START/STOP/Reset controls

API routes handle:
- `POST /api/chat` — spawns a claude session for direct chat (Phase 0 or post-build)
- `POST /api/start-pipeline` — creates project dir from staging, spawns orchestrator
- `POST /api/stop-pipeline` — kills orchestrator + claude sessions
- `POST /api/reset` — clears staging, resets stuck projects
- `GET /api/state` — returns current pipeline state
- `POST /api/approve` — approves/denies dangerous bash commands

## Data Flow

```
User types in viewer
  -> POST /api/chat -> spawns claude session -> writes to .staging/pipeline-events.json
  -> GET /api/state polls .staging/ -> viewer renders events

User hits START
  -> POST /api/start-pipeline
  -> staging moves to ~/Builds/<project>/
  -> orchestrator spawns as detached process
  -> orchestrator writes to ~/Builds/<project>/pipeline-events.json
  -> GET /api/state polls project dir -> viewer renders events

User hits STOP
  -> POST /api/stop-pipeline -> pkill orchestrator + claude sessions

User hits RESET
  -> POST /api/reset -> clears staging, resets active projects
```

## Communication Map

```
     ┌─────┐
     │ YOU │  gives concept, answers A's questions (Phase 0 only)
     └──┬──┘
        │
        ┌─────┐
        │  B  │  plan reviewer — only talks to A
        └──┬──┘
           │
     ┌─────┴─────┐
     │     A     │  planner / deployer — talks to everyone
     └─────┬─────┘
           │
     ┌─────┴─────┐
     │     C     │  coder — talks to A (questions) and D (code)
     └─────┬─────┘
           │
     ┌─────┴─────┐
     │     D     │  reviewer + tester — talks to C (fixes) and A (final)
     └───────────┘

     S sits above — available when things go sideways

     After Phase 0, pipeline runs fully autonomous
     All sessions: claude --permission-mode auto --model claude-opus-4-6
```

## Manual Mode

In manual mode, the orchestrator does not exist. The user is the orchestrator.

- **No pipeline, no phases, no automation.** 5 Claude sessions with one-line expertise labels.
- **State lives in `~/Builds/.manual/manual-state.json`** — separate from pipeline state.
- **No role files.** Agents get a one-line system prompt on first message:
  - A: "You specialize in software planning and architecture."
  - B: "You specialize in code review and finding gaps."
  - C: "You specialize in writing code."
  - D: "You specialize in testing and debugging."
  - S: "You help oversee and diagnose issues."
- **No `PIPELINE_AGENT` env var** — hooks don't apply pipeline restrictions.
- **Model picker** — user chooses Opus or Sonnet per session.
- **Handoff button** — grabs an agent's last text response and stages it as context for the next agent messaged. Max 2000 chars.
- **Per-agent sending** — multiple agents can be active simultaneously.
- **Session resume** — sessions persist in `manual-state.json` and resume via `--resume`.

```
Manual Mode Data Flow

User types in any panel
  -> POST /api/chat { mode: 'manual', model, agent, message }
  -> spawns claude with --system-prompt (first msg) or --resume (subsequent)
  -> cwd: ~/Builds/.manual/
  -> streams events into manual-state.json
  -> GET /api/state?mode=manual polls manual-state.json -> viewer renders

User hits RESET
  -> POST /api/reset { mode: 'manual' } -> deletes ~/Builds/.manual/
```
