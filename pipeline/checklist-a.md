<!-- Role-scoped: Agent A sections only. Full checklist: checklist-template.md -->

# Pipeline Checklist

This checklist travels with the build. Each agent checks off their section before passing it forward. No agent should move to the next phase until the previous section is fully checked off.

This is not just pipeline paperwork. It is part of the team's shared doctrine. The supervisor, planner, reviewer, coder, and tester should all treat it as the operating system for the build.

Every handoff includes a message. The message format is specified at each handoff point — follow it exactly.

**Build:** _(name of feature/task)_
**Started:** _(date)_
**Project folder:** _(The pipeline creates this in `~/Builds/` based on the project theme — e.g. `~/Builds/auth-refactor/`)_

---

## Phase 0: Concept — User → Agent A (Planner)

### Concept Intake (A)
- [ ] Received build concept from user
- [ ] Asked clarifying questions (if needed)
- [ ] Received answers from user (if needed)
- [ ] Concept is clear — ready to plan

> **From:** User
> **To:** A (Planner)
> **Phase:** Concept
> **Build concept:** _(what the user wants built)_

If A needs clarification:

> **From:** A (Planner)
> **To:** User
> **Phase:** Concept
> **Questions:**
> 1. _(question)_

User answers, A continues. This is usually the last direct human interaction in fast mode. In strict mode, the UI can still surface Bash approvals later.

Today the pipeline still starts with A in Phase 0. The product direction is for S to become the primary manager/operator above the rest of the team.

---

## Phase 1: Planning — Agent A (Planner)

### Setup (A)
- [ ] Work inside the project folder in `~/Builds/` — named based on the project theme or idea
- [ ] Copy this checklist into the project folder (e.g. `~/Builds/project-name/checklist.md`)
- [ ] Read `build-plan-template.md` — this is your playbook. Follow it step by step. Understand the principles: research first, verify from source, no guesswork, give the coder full context, review until bulletproof.
- [ ] Create the plan file in the project folder (e.g. `~/Builds/project-name/plan.md`)

### Research (A)
- [ ] Read relevant architecture docs
- [ ] Read the actual source code for files that will be modified
- [ ] Web search if needed (external APIs, packages, docs)
- [ ] GitHub search if needed (repos, issues, examples)
- [ ] Package verify if needed (install, read source, confirm it works)

### Write (A)
- [ ] What we're building — clear, concise summary
- [ ] How it works — the pattern/flow
- [ ] Files to create — with code templates
- [ ] Files to modify — with exact line numbers and code snippets
- [ ] Special cases called out
- [ ] Architecture rules listed

### Verify (A)
- [ ] Zero guesses — every package, function, field, and line number verified from actual source
- [ ] No shortcuts — everything works completely or is explicitly deferred with a reason

### Context (A)
- [ ] Coder has full context — knows what to read, research, and build before starting
- [ ] Coder can build without asking a single question

### Self-Review (A)
- [ ] Read the plan as a fresh session — found and filled all gaps
- [ ] Reviewed again

### Handoff (A → B)
- [ ] All above checkboxes complete
- [ ] Plan file is written and saved in the project folder
- [ ] Send message to B:

> **From:** A (Planner)
> **To:** B (Plan Reviewer)
> **Phase:** Plan Review
> **Action needed:** Review this plan. Send back any questions — gaps, assumptions, anything unverified. If you have zero concerns, approve it and send it back.
>
> **The plan:** _(path to plan file in project folder)_
> **What I researched:** _(list sources read — docs, source code, web)_
> **What I verified:** _(list what was confirmed from source)_
> **What the coder needs to know:** _(key context for C)_

The goal is not just "hand B a file." The goal is to hand the team a plan that the rest of the build can trust.

---

## Phase 1b: Final Plan (A)
- [ ] A locks the plan — this is now the final, unmodifiable copy. No agent changes this file from this point forward. All agents reference this single file as the source of truth.

---

## Phase 5: Deploy — Agent A (Planner)

### Receive (A)
- [ ] Received reviewed and tested code from D
- [ ] Confirmed D's review and test summaries look correct

### Finalize (A)
- [ ] Committed _(if repo exists)_
- [ ] Pushed _(if repo exists)_
- [ ] Deployed _(if applicable)_
- [ ] Build complete
