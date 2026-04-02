import assert from 'node:assert/strict';

import { buildSupervisorSnapshot, getSupervisorUpdate } from '../src/lib/pipeline-supervisor.ts';

const pausedSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Tiny hello page',
    currentPhase: 'plan-review',
    pipelineStatus: 'paused',
    securityMode: 'fast',
    runGoal: 'plan-only',
    stopAfterPhase: 'plan-review',
    activeAgent: '',
    buildComplete: false,
    agentStatus: { A: 'idle', B: 'done', C: 'idle', D: 'idle', S: 'idle' },
    runtime: { activeTurn: null },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'B', phase: 'plan-review', type: 'approval', text: 'PLAN APPROVED' }],
  },
  null
);

assert.match(pausedSnapshot, /Run goal: plan-only/);
assert.match(pausedSnapshot, /Pipeline status: paused/);
assert.match(pausedSnapshot, /Supervisor update:/i);
assert.match(pausedSnapshot, /Planning is done/i);
assert.match(pausedSnapshot, /Recommended supervisor action:/i);
assert.match(pausedSnapshot, /Plan approved, waiting on you/i);
assert.match(pausedSnapshot, /try: "continue build"/i);

const stalledSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Tiny hello page',
    currentPhase: 'planning',
    pipelineStatus: 'running',
    securityMode: 'fast',
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    activeAgent: 'A',
    buildComplete: false,
    agentStatus: { A: 'active', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    runtime: {
      activeTurn: {
        agent: 'A',
        phase: 'planning',
        status: 'stalled',
        lastEventAt: '2026-04-02T00:00:00.000Z',
        promptSummary: 'Write plan.md',
        autoResumeCount: 1,
      },
    },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'system', phase: 'planning', type: 'status', text: 'Agent A appears stalled.' }],
  },
  null
);

assert.match(stalledSnapshot, /Active turn: A \/ planning \/ stalled/);
assert.match(stalledSnapshot, /A planning turn looks recoverable/i);
assert.match(stalledSnapshot, /Recoverable A stall/i);
assert.match(stalledSnapshot, /try: "resume stalled run"/i);

const idleFailureSnapshot = buildSupervisorSnapshot(
  {
    concept: '',
    currentPhase: 'concept',
    pipelineStatus: 'idle',
    securityMode: 'fast',
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    activeAgent: '',
    buildComplete: false,
    agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    runtime: { activeTurn: null },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'S', phase: 'concept', type: 'failure', text: 'No build concept found yet.' }],
  },
  null
);

assert.match(idleFailureSnapshot, /Tell S what to build/i);
assert.doesNotMatch(idleFailureSnapshot, /Something needs attention/i);

const codingUpdate = getSupervisorUpdate(
  {
    concept: 'Tiny hello page',
    currentPhase: 'coding',
    pipelineStatus: 'running',
    securityMode: 'fast',
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    activeAgent: 'C',
    buildComplete: false,
    agentStatus: { A: 'done', B: 'done', C: 'active', D: 'idle', S: 'idle' },
    runtime: {
      activeTurn: {
        agent: 'C',
        phase: 'coding',
        status: 'running',
        lastEventAt: '2026-04-02T00:00:00.000Z',
        promptSummary: 'Build the app',
        autoResumeCount: 0,
      },
    },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'C', phase: 'coding', type: 'status', text: 'Coder is implementing the approved plan.' }],
  },
  null
);

assert.equal(codingUpdate.title, 'The coder is implementing the approved plan');
assert.match(codingUpdate.summary, /locked plan/i);
assert.match(codingUpdate.ask || '', /no action needed/i);

const fallbackUpdate = getSupervisorUpdate(
  {
    concept: 'Tiny hello page',
    currentPhase: 'coding',
    pipelineStatus: 'running',
    securityMode: 'fast',
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    activeAgent: 'C',
    buildComplete: false,
    agentStatus: { A: 'done', B: 'done', C: 'active', D: 'idle', S: 'idle' },
    runtime: {
      activeTurn: {
        agent: 'C',
        phase: 'coding',
        status: 'running',
        lastEventAt: '2026-04-02T00:00:00.000Z',
        promptSummary: 'Build the app',
        autoResumeCount: 0,
      },
    },
    events: [
      { time: '2026-04-02T00:00:00.000Z', agent: 'system', phase: 'coding', type: 'status', text: 'Isolated coder auth is unavailable. Retrying on the host.' },
    ],
  },
  null
);

assert.equal(fallbackUpdate.title, 'An isolated worker fell back to host');
assert.match(fallbackUpdate.summary, /subscription auth/i);
assert.match(fallbackUpdate.ask || '', /graceful fallback/i);

console.log('supervisor snapshot checks passed');
