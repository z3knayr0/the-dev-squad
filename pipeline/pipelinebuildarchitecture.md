# Pipeline Build Architecture

Five agents. Each has one job. They pass work back and forth until it's perfect.

This file is the conceptual pipeline sketch. For the current implementation and security model, use [ARCHITECTURE.md](../ARCHITECTURE.md), [SECURITY.md](../SECURITY.md), and [SECURITY-ROADMAP.md](../SECURITY-ROADMAP.md).

---

## The Agents

- **S — Supervisor**: Diagnostic assistant available on demand. Reads broadly, helps when things go wrong, and is not part of the normal autonomous loop.
- **A — Planner**: Builds the plan, answers questions, owns the lifecycle from start to finish
- **B — Plan Reviewer**: Pokes holes in the plan until there are none left
- **C — Coder**: Follows the approved plan and writes the code
- **D — Code Reviewer + Tester**: Reviews the code against the plan, then tests it

---

## The Flow

### Phase 0: Concept

1. The **user** gives the build concept to **A**. This is the only required human interaction.
2. **A** can ask the user clarifying questions — what do you want, how should it work, any constraints? The user answers. This is the last time the user needs to be involved.
3. From this point forward, the pipeline runs autonomously by default. The user usually watches the dashboard rather than steering the flow, but approvals can still appear for Bash commands and future strict mode intentionally adds more human gating.

### Phase 1: Planning

4. **A** creates a project folder in `/Projects/` — named based on the project theme or idea. All files for this build live here.
5. **A** reads `build-plan-template.md`. This is A's playbook. A follows it step by step.
6. **A** completes the entire checklist in the template — research, write, verify, context, review. Every checkbox must be done before A sends anything to B.
7. **A** writes the plan to a file in the project folder (e.g. `plan.md`). This is the single source of truth.
8. When the checklist is fully complete, **A** sends the plan to **B** with context — what was researched, what was verified, what the coder needs to know.
9. **B** reads the plan and sends questions back to **A**. These are real questions — gaps, assumptions, things that don't add up. If B has no questions, B approves immediately.
10. **A** answers every question with verified information and updates the plan file.
11. **B** reviews the answers. If satisfied, **B** tells **A** the plan is approved. If not, **B** sends more questions.
12. This continues until **B** is fully satisfied. There is no round limit. The plan is not done until **B** says it's done.
13. **B** tells **A** the plan is approved. **B's job is now finished. B is never in the loop again.**
14. **A** locks the plan. This is now the final, unmodifiable copy. No agent changes this file from this point forward. All agents reference this single file.

### Phase 2: Coding

15. **A** sends the approved plan to **C**.
16. **C** reads the plan and builds exactly what it says. No improvising, no interpreting, no "improving."
17. If **C** has a question — something unexpected at implementation time — **C** asks **A**. **A** answers. **C** continues.
18. When **C** is finished coding, **C** sends the code to **D**.

### Phase 3: Code Review

19. **D** reads the plan. **D** reads the code. **D** checks: does the code match the plan?
20. If **D** has issues — missing pieces, wrong implementation, things that don't match the plan — **D** sends recommended fixes back to **C**.
21. **C** makes the fixes and sends back to **D**.
22. **D** reviews the fixes. If **D** still has issues, back to **C**. If **D** is satisfied with the code, **D** moves to testing.

### Phase 4: Testing

23. **D** runs the code. Tests it. Confirms it actually works — not just that it looks right, but that it runs.
24. If tests fail, **D** sends failures back to **C** with what broke. **C** fixes and sends back. **D** tests again.
25. When **D** is satisfied the code is correct and working, **D** sends it back to **A**.

### Phase 5: Deploy

26. **A** receives the reviewed and tested code.
27. **A** commits, pushes, and deploys if applicable.
28. Build complete.

---

## Rules

- **A** is the only agent that talks to everyone. A is the orchestrator.
- **B** only ever talks to **A**. B reviews the plan and nothing else.
- **C** talks to **A** (questions) and **D** (code handoff and fixes).
- **D** talks to **C** (review feedback) and **A** (final handoff when done).
- Every agent is aware of every other agent and their role.
- **A** creates a project folder in `/Projects/` for every build. All files live there — plan, checklist, code.
- **A** reads and follows `build-plan-template.md`. The entire checklist — research, write, verify, context, review — is A's job. A completes every checkbox before sending anything to B. A sends the plan with context so B knows what was researched and verified.
- The plan is one file in one location. All agents reference it by path. After B approves, A locks it — no agent modifies it from that point forward.
- If it's not verified from source, it doesn't go in the plan. If it's not in the plan, it doesn't go in the code.
- No agent guesses. No agent improvises. No agent skips steps.

## Session Spawning

Each agent runs as a separate Claude Code session. Sessions are spawned with:

```bash
claude --permission-mode auto --model claude-opus-4-6
```

- `--permission-mode auto` uses Claude's classifier for general safety, but pipeline builds can still surface approval prompts for Bash depending on command risk and future strict-mode settings.
- Our PreToolUse hook stacks on top — enforces per-agent restrictions (A can only write plan.md, D can't write, etc.).
- `--model claude-opus-4-6` sets Opus 4.6.
- Each session gets a CLAUDE.md or system prompt defining its role, what it can do, and who it talks to.
- Stronger containment is a roadmap item, not a current guarantee. See [SECURITY-ROADMAP.md](../SECURITY-ROADMAP.md).

## Human Interaction

The user is mainly involved at the start:
1. User gives the build concept to A.
2. A can ask clarifying questions. User answers.
3. Pipeline runs autonomously from that point in the default mode, but the UI can still surface approvals for some Bash operations and future strict mode adds approval for all C/D Bash.
4. User gets notified when the build is complete.

The dashboard is mostly a monitoring window, but it can also become an approval surface when the policy requires it.

---

## Visual

```
╔══════════════════════════════════════════════════════════════════════════╗
║                        PHASE 0: CONCEPT                                ║
║                                                                        ║
║   ┌───────────┐       build concept        ┌───────────┐              ║
║   │    YOU     │ ─────────────────────────→ │     A     │              ║
║   │  (human)   │ ←─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │  PLANNER  │              ║
║   └───────────┘   clarifying questions      └───────────┘              ║
║                    (if needed)                                          ║
║                                                                        ║
║        last human interaction — pipeline runs autonomously from here   ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 1: PLANNING                               ║
║                                                                        ║
║   ┌───────────┐                                                        ║
║   │     A     │  1. create project folder in /Projects/                ║
║   │  PLANNER  │  2. read build-plan-template.md                        ║
║   │           │  3. research, write, verify, context, self-review      ║
║   │           │  4. write plan to project folder (plan.md)             ║
║   └───────────┘                                                        ║
║        │                                                               ║
║        │            sends plan                                         ║
║        ▼                                                               ║
║   ┌───────────┐                             ┌───────────┐              ║
║   │           │ ─────────────────────────→  │           │              ║
║   │     A     │                             │     B     │              ║
║   │  PLANNER  │  ←───────────────────────── │ PLAN      │              ║
║   │           │   questions / no feedback    │ REVIEWER  │              ║
║   └───────────┘                             └───────────┘              ║
║        │  ↑                                      │                     ║
║        │  │    answers + updated plan             │                     ║
║        │  └──────────────────────────────────────┘                     ║
║        │                                                               ║
║        │        ↕ repeats until B is satisfied                         ║
║        │        ✓ B approves → B is done forever                       ║
║        │                                                               ║
║   ┌───────────┐                                                        ║
║   │     A     │  locks the plan — final, unmodifiable copy             ║
║   │  PLANNER  │  all agents reference this file from now on            ║
║   └───────────┘                                                        ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 2: CODING                                 ║
║                                                                        ║
║   ┌───────────┐       approved plan        ┌───────────┐              ║
║   │     A     │ ─────────────────────────→ │     C     │              ║
║   │  PLANNER  │                             │   CODER   │              ║
║   │           │ ←─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │           │              ║
║   └───────────┘   questions (if needed)     └───────────┘              ║
║                                                  │                     ║
║                          C builds exactly what the plan says           ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 3: CODE REVIEW                            ║
║                                                                        ║
║   ┌───────────┐        sends code          ┌───────────┐              ║
║   │     C     │ ─────────────────────────→ │     D     │              ║
║   │   CODER   │                             │   CODE    │              ║
║   │           │ ←───────────────────────── │ REVIEWER   │              ║
║   └───────────┘    recommended fixes        └───────────┘              ║
║        │  ↑                                      │                     ║
║        │  │         sends fixed code             │                     ║
║        │  └──────────────────────────────────────┘                     ║
║        │                                                               ║
║        │        ↕ repeats until D is satisfied with code               ║
║        │        ✓ D satisfied → moves to testing                       ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 4: TESTING                                ║
║                                                                        ║
║   ┌───────────┐                             ┌───────────┐              ║
║   │     C     │                             │     D     │              ║
║   │   CODER   │ ←───────────────────────── │  TESTER   │              ║
║   │           │     test failures            │           │              ║
║   │           │ ─────────────────────────→  │           │              ║
║   └───────────┘     fixes                   └───────────┘              ║
║                                                  │                     ║
║                  ↕ repeats until all tests pass   │                    ║
║                  ✓ D satisfied → sends to A       │                    ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 5: DEPLOY                                 ║
║                                                                        ║
║   ┌───────────┐                                                        ║
║   │     D     │ ── tested + reviewed code ──→ ┌───────────┐           ║
║   └───────────┘                                │     A     │           ║
║                                                │  PLANNER  │           ║
║                                                │           │           ║
║                                                │ • commit  │           ║
║                                                │ • push    │           ║
║                                                │ • deploy  │           ║
║                                                └───────────┘           ║
║                                                     │                  ║
║                                                   DONE                 ║
╚══════════════════════════════════════════════════════════════════════════╝
```

```
COMMUNICATION MAP — who talks to who

     ┌─────┐
     │ YOU │  gives concept, answers A's questions (Phase 0 only)
     └──┬──┘
        │
        │ concept + answers
        │
        ┌─────┐
        │  B  │  plan reviewer
        └──┬──┘
           │
           │ only talks to A
           │
     ┌─────┴─────┐
     │     A     │
     │ planner / │
     │  deployer │
     └─────┬─────┘
           │
    ┌──────┴──── ─ ─ (questions if needed)
    │      │
    │  ┌───┴───┐
    │  │   C   │  coder
    │  └───┬───┘
    │      │
    │      │ code + fixes
    │      │
    │  ┌───┴───┐
    └──│   D   │  code reviewer + tester
       └───────┘
           │
           └──→ back to A when done

    after Phase 0, pipeline runs autonomous by default
    all sessions: claude --permission-mode auto --model claude-opus-4-6
```
