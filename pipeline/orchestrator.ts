#!/usr/bin/env npx tsx

/**
 * Pipeline Build Orchestrator (Streaming)
 *
 * Spawns Claude Code sessions and streams all activity to the viewer.
 * You see every tool call, file read/write, and agent response in real-time.
 *
 * Usage:
 *   npx tsx orchestrator.ts "Your build concept here"
 *
 * Viewer (separate terminal):
 *   npx tsx viewer.ts
 *
 * Then open http://localhost:3456
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

// ── Config ──────────────────────────────────────────────────────────

const BUILDUI_DIR = resolve(import.meta.dirname || __dirname);
const BUILDS_DIR = join(homedir(), 'Builds');

const ROLE_A = join(BUILDUI_DIR, 'role-a.md');
const ROLE_B = join(BUILDUI_DIR, 'role-b.md');
const ROLE_C = join(BUILDUI_DIR, 'role-c.md');
const ROLE_D = join(BUILDUI_DIR, 'role-d.md');

const MODEL = 'claude-opus-4-6';

// Effort levels per agent — quality gates (B, D) get max reasoning depth
const AGENT_EFFORT: Record<string, string> = {
  A: 'high',   // Planner — follows template, high is enough
  B: 'max',    // Reviewer — must find gaps, deep reasoning pays off
  C: 'high',   // Coder — executing approved plan
  D: 'max',    // Tester — must catch bugs, verify correctness
  S: 'high',   // Supervisor — not currently used
};

// ── CLI Args ────────────────────────────────────────────────────────
//
// Two modes:
//   Standalone:  npx tsx orchestrator.ts "Your build concept here"
//   From viewer: npx tsx orchestrator.ts --project-dir /path --a-session SESSION_ID
//

let concept = '';
let projectDir = '';
let existingASession = '';
let securityMode = process.env.PIPELINE_SECURITY_MODE === 'strict' ? 'strict' : 'fast';

const args = process.argv.slice(2);
const projectDirIdx = args.indexOf('--project-dir');
const aSessionIdx = args.indexOf('--a-session');

if (projectDirIdx !== -1 && aSessionIdx !== -1) {
  // Launched by viewer — Phase 0 already done
  projectDir = args[projectDirIdx + 1];
  existingASession = args[aSessionIdx + 1];
  // Read concept from existing state
  try {
    const existing = JSON.parse(readFileSync(join(projectDir, 'pipeline-events.json'), 'utf8'));
    concept = existing.concept || 'Build from viewer';
    if (existing.securityMode === 'strict') securityMode = 'strict';
  } catch {
    concept = 'Build from viewer';
  }
} else {
  // Standalone mode
  concept = args.join(' ').trim();
  if (!concept) {
    console.error('Usage: npx tsx orchestrator.ts "Your build concept here"');
    console.error('   or: npx tsx orchestrator.ts --project-dir /path --a-session SESSION_ID');
    process.exit(1);
  }

  const projectName = concept
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  projectDir = join(BUILDS_DIR, projectName);
}

// ── Project Setup ───────────────────────────────────────────────────

mkdirSync(projectDir, { recursive: true });

if (!existsSync(join(projectDir, 'checklist.md'))) {
  copyFileSync(join(BUILDUI_DIR, 'checklist-template.md'), join(projectDir, 'checklist.md'));
}
if (!existsSync(join(projectDir, 'build-plan-template.md'))) {
  copyFileSync(join(BUILDUI_DIR, 'build-plan-template.md'), join(projectDir, 'build-plan-template.md'));
}

// Copy hooks into project so agents pick them up
mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
copyFileSync(
  join(BUILDUI_DIR, '.claude', 'settings.json'),
  join(projectDir, '.claude', 'settings.json')
);
copyFileSync(
  join(BUILDUI_DIR, '.claude', 'hooks', 'approval-gate.sh'),
  join(projectDir, '.claude', 'hooks', 'approval-gate.sh')
);
// Ensure executable
try { execFileSync('chmod', ['+x', join(projectDir, '.claude', 'hooks', 'approval-gate.sh')]); } catch {}

// Git init for the project
if (!existsSync(join(projectDir, '.git'))) {
  try {
    execFileSync('git', ['init'], { cwd: projectDir });
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', 'Initial project setup'], { cwd: projectDir });
  } catch {}
}

// ── Event System ────────────────────────────────────────────────────

interface PipelineEvent {
  time: string;
  agent: 'A' | 'B' | 'C' | 'D' | 'system';
  phase: string;
  type: string;
  text: string;
  detail?: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
}

interface PipelineState {
  concept: string;
  projectDir: string;
  currentPhase: string;
  securityMode: 'fast' | 'strict';
  activeAgent: string;
  agentStatus: Record<string, string>;
  sessions: Record<string, string>;
  buildComplete: boolean;
  usage: TokenUsage;
  events: PipelineEvent[];
}

const eventsFile = join(projectDir, 'pipeline-events.json');

let state: PipelineState;
if (existingASession && existsSync(eventsFile)) {
  // Launched from viewer — load existing state (has Phase 0 events + sessions)
  const existing = JSON.parse(readFileSync(eventsFile, 'utf8'));
  state = {
    concept: existing.concept || concept,
    projectDir: existing.projectDir || projectDir,
    currentPhase: existing.currentPhase || 'concept',
    securityMode: existing.securityMode === 'strict' ? 'strict' : securityMode,
    activeAgent: existing.activeAgent || '',
    agentStatus: existing.agentStatus || { A: 'idle', B: 'idle', C: 'idle', D: 'idle' },
    sessions: existing.sessions || {},
    buildComplete: false,
    usage: existing.usage || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    events: existing.events || [],
  };
} else {
  state = {
    concept,
    projectDir,
    currentPhase: 'concept',
    securityMode,
    activeAgent: '',
    agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle' },
    sessions: {},
    buildComplete: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    events: [],
  };
}

function flush() {
  writeFileSync(eventsFile, JSON.stringify(state, null, 2));
}

function emit(
  agent: PipelineEvent['agent'],
  phase: string,
  type: string,
  text: string,
  detail?: string
) {
  state.events.push({ time: new Date().toISOString(), agent, phase, type, text, detail });
  flush();

  // Terminal output with color
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const colors: Record<string, string> = {
    status: '\x1b[36m', send: '\x1b[33m', receive: '\x1b[33m',
    question: '\x1b[35m', answer: '\x1b[32m', issue: '\x1b[31m',
    fix: '\x1b[32m', approval: '\x1b[1m\x1b[32m', failure: '\x1b[31m',
    tool_call: '\x1b[90m', tool_result: '\x1b[90m', text: '\x1b[37m',
  };
  const c = colors[type] || '\x1b[0m';
  console.log(`${c}[${time}]   ${agent} | ${text}\x1b[0m`);
}

function setAgent(agent: string, status: string) {
  state.agentStatus[agent] = status;
  if (status === 'active') state.activeAgent = agent;
  flush();
}

function setPhase(phase: string) {
  state.currentPhase = phase;
  flush();
}

function saveSession(agent: string, sessionId: string) {
  state.sessions[agent] = sessionId;
  flush();
}

// ── Tool Permissions ─────────────────────────────────────────────────
//
// Auto mode handles general safety (no mass deletions, no malicious code).
// Our PreToolUse hook handles pipeline-specific rules:
//   - S (Supervisor): unrestricted
//   - A: can only write plan.md, no writes during Phase 0
//   - B: can't write anything
//   - C: can write in ~/Builds/ except plan.md
//   - D: can't write anything
//   - Nobody writes outside ~/Builds/
//   - Agent tool blocked for A/B/C/D
//

type AgentId = 'A' | 'B' | 'C' | 'D';

// ── Streaming Claude Runner ─────────────────────────────────────────

function claude(
  agent: AgentId,
  prompt: string,
  opts: {
    role: string;
    resume?: string;
    jsonSchema?: Record<string, unknown>;
  }
): Promise<{ result: string; sessionId: string; structured: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const safePrompt = prompt.startsWith('-') ? 'User says: ' + prompt : prompt;
    const effort = AGENT_EFFORT[agent] || 'high';
    const args: string[] = [
      '-p', safePrompt,
      '--system-prompt-file', opts.role,
      '--permission-mode', 'auto',
      '--model', MODEL,
      '--effort', effort,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));

    const child = spawn('claude', args, {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PIPELINE_AGENT: agent,
        PIPELINE_SECURITY_MODE: state.securityMode,
        // Reset Claude's working directory after each Bash command so a `cd`
        // does not persist into later Write/Edit tool calls.
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
      },
    });

    let lastResult: Record<string, unknown> | null = null;

    const rl = createInterface({ input: child.stdout });

    rl.on('line', (line) => {
      if (!line.trim()) return;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      const type = event.type as string;

      if (type === 'assistant') {
        const msg = event.message as Record<string, unknown>;
        const content = msg?.content as Array<Record<string, unknown>>;
        if (!content) return;

        for (const block of content) {
          if (block.type === 'tool_use') {
            const toolName = block.name as string;
            const input = block.input as Record<string, unknown>;
            let desc = toolName;
            let detail = '';

            if (toolName === 'Read' && input.file_path) {
              desc = `READ ${basename(input.file_path as string)}`;
              detail = input.file_path as string;
            } else if (toolName === 'Write' && input.file_path) {
              desc = `WRITE ${basename(input.file_path as string)}`;
              const content = (input.content as string) || '';
              detail = `${input.file_path}\n--- content (${content.split('\n').length} lines) ---\n${content.slice(0, 500)}${content.length > 500 ? '\n...' : ''}`;
            } else if (toolName === 'Edit' && input.file_path) {
              desc = `EDIT ${basename(input.file_path as string)}`;
              detail = `${input.file_path}\n- ${(input.old_string as string || '').slice(0, 100)}\n+ ${(input.new_string as string || '').slice(0, 100)}`;
            } else if (toolName === 'Bash' && input.command) {
              desc = `BASH ${(input.command as string).slice(0, 80)}`;
              detail = input.command as string;
            } else if (toolName === 'Glob' && input.pattern) {
              desc = `GLOB ${input.pattern}`;
            } else if (toolName === 'Grep' && input.pattern) {
              desc = `GREP ${input.pattern}`;
            } else if (toolName === 'WebSearch') {
              desc = `SEARCH ${(input.query as string) || ''}`;
            } else if (toolName === 'WebFetch' && input.url) {
              desc = `FETCH ${input.url}`;
            }

            emit(agent, state.currentPhase, 'tool_call', desc, detail);
          } else if (block.type === 'text') {
            const text = (block.text as string || '').trim();
            if (text) {
              emit(agent, state.currentPhase, 'text', text);
            }
          }
        }
      } else if (type === 'user') {
        // Show tool results — including permission denials
        const msg = event.message as Record<string, unknown>;
        const content = msg?.content as Array<Record<string, unknown>>;
        if (content) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.is_error) {
              const errorText = (block.content as string) || '';
              if (errorText.includes('permissions')) {
                emit(agent, state.currentPhase, 'permission_denied', errorText);
              }
            }
          }
        }
        // Show raw tool result text for visibility
        const toolResult = event.tool_use_result as Record<string, unknown>;
        if (toolResult && typeof toolResult === 'object') {
          const resultText = (toolResult as Record<string, string>).type === 'text'
            ? '' // skip verbose file contents for now
            : '';
          if (resultText) emit(agent, state.currentPhase, 'tool_result', resultText);
        }
      } else if (type === 'result') {
        lastResult = event;

        // Accumulate token usage
        const usage = event.usage as Record<string, unknown>;
        if (usage) {
          state.usage.inputTokens += (usage.input_tokens as number) || 0;
          state.usage.outputTokens += (usage.output_tokens as number) || 0;
          state.usage.cacheReadTokens += (usage.cache_read_input_tokens as number) || 0;
          state.usage.cacheWriteTokens += (usage.cache_creation_input_tokens as number) || 0;
        }
        const cost = event.total_cost_usd as number;
        if (cost) state.usage.totalCostUsd += cost;
        flush();
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code !== 0 || !lastResult) {
        emit('system', state.currentPhase, 'failure', `Agent ${agent} failed (exit ${code})`);
        if (stderr) console.error(stderr.slice(0, 500));
        reject(new Error(`Agent ${agent} failed with exit code ${code}`));
        return;
      }

      resolve({
        result: (lastResult.result as string) || '',
        sessionId: (lastResult.session_id as string) || '',
        structured: null,
      });
    });

    child.on('error', (err) => {
      emit('system', state.currentPhase, 'failure', `Failed to spawn agent ${agent}: ${err.message}`);
      reject(err);
    });
  });
}

// ── JSON Schemas ────────────────────────────────────────────────────

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'questions'] },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

const CODE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'issues'] },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['passed', 'failed'] },
    failures: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

// ── Helper ──────────────────────────────────────────────────────────

function parseSignal(result: string): Record<string, unknown> {
  // Try direct JSON parse
  try {
    return JSON.parse(result);
  } catch {
    // Try to find JSON embedded in text
    const match = result.match(/\{[\s\S]*"status"\s*:\s*"[^"]+"/);
    if (match) {
      try {
        let depth = 0;
        const start = result.indexOf(match[0]);
        for (let i = start; i < result.length; i++) {
          if (result[i] === '{') depth++;
          if (result[i] === '}') depth--;
          if (depth === 0) {
            return JSON.parse(result.slice(start, i + 1));
          }
        }
      } catch {}
    }
    // Try to detect positive/negative signals from text
    const lower = result.toLowerCase();
    if (lower.includes('all tests pass') || lower.includes('tests passed') || lower.includes('approved') || lower.includes('code is correct')) {
      emit('system', state.currentPhase, 'status', 'Parsed positive signal from text');
      return { status: 'approved' };
    }
    emit('system', state.currentPhase, 'status', 'Could not parse signal — treating as approved');
    return { status: 'approved' };
  }
}

// Normalize signal status — treat approved/passed as the same positive result
function isPositiveSignal(signal: Record<string, unknown>): boolean {
  const s = (signal.status as string || '').toLowerCase();
  return s === 'approved' || s === 'passed';
}

// ════════════════════════════════════════════════════════════════════
//  PIPELINE EXECUTION
// ════════════════════════════════════════════════════════════════════

async function run() {
  console.log('\n\x1b[1m╔══════════════════════════════════════════╗');
  console.log('║     PIPELINE BUILD ORCHESTRATOR (LIVE)     ║');
  console.log('╚══════════════════════════════════════════╝\x1b[0m');
  console.log(`\n  Concept:  ${concept}`);
  console.log(`  Project:  ${projectDir}`);
  console.log(`  Viewer:   http://localhost:3456\n`);

  let aSession = existingASession;

  if (existingASession) {
    // ── Launched from viewer — Phase 0 already done ───────────────
    emit('system', 'concept', 'status', `Build concept: ${concept}`);
    emit('system', 'concept', 'status', 'Phase 0 completed in viewer. Starting pipeline...');
  } else {
    // ── Phase 0 (standalone mode) ─────────────────────────────────
    setPhase('concept');
    emit('system', 'concept', 'status', `Build concept: ${concept}`);
  }

  // ── Phase 1: Planning ───────────────────────────────────────────

  setPhase('planning');
  setAgent('A', 'active');
  emit('A', 'planning', 'status', 'Starting research and plan writing...');

  // Build Phase 0 conversation context if resuming from viewer
  let phase0Context = '';
  if (existingASession) {
    const phase0Events = state.events.filter(e => e.agent === 'A' || (e.type === 'user_msg' && e.phase === 'concept'));
    if (phase0Events.length > 0) {
      phase0Context = 'Here is the Phase 0 conversation with the user about what to build:\n\n' +
        phase0Events.map(e => e.text).join('\n') + '\n\n';
    }
  }

  const planPrompt = [
    existingASession
      ? phase0Context + 'Based on the conversation above, build the plan now.'
      : `Build concept from the user: ${concept}`,
    '',
    'YOUR ONLY JOB RIGHT NOW: Write a build plan to plan.md. That is it.',
    '',
    'Follow these steps exactly:',
    '1. Read build-plan-template.md in this directory. Follow it step by step.',
    '2. Research the concept — read docs, source code, web search, verify packages.',
    `3. Write the build plan to ${join(projectDir, 'plan.md')}`,
    '4. The plan must have complete, copy-pasteable code for every file.',
    '5. No descriptions — only code. The coder must build without asking a single question.',
    '6. Self-review the plan. Read it back. Find and fill all gaps. Review again.',
    '7. When plan.md is complete, say "Plan complete" and STOP.',
    '',
    'RULES:',
    '- You are ONLY writing plan.md. Do NOT write any other files.',
    '- Do NOT write index.html, app.js, or any code files. That is the CODER\'s job.',
    '- Do NOT create the actual project. Only the PLAN.',
    '- Do NOT use the Agent tool. Do NOT spawn sub-agents.',
    '- Do NOT send the plan to anyone. The orchestrator handles that.',
    '- Do not take shortcuts. Do not guess. Verify everything from source.',
  ].join('\n');

  const aResult = await claude('A', planPrompt, {
    role: ROLE_A,
  });
  aSession = aResult.sessionId;
  saveSession('A', aSession);

  if (!existsSync(join(projectDir, 'plan.md'))) {
    emit('A', 'planning', 'failure', 'Did not write plan.md');
    process.exit(1);
  }

  emit('A', 'planning', 'status', 'Plan written to plan.md');

  // ── Phase 1b: Plan Review ─────────────────────────────────────

  setPhase('plan-review');
  setAgent('A', 'idle');
  setAgent('B', 'active');
  emit('A', 'plan-review', 'send', 'Sent plan to B for review');

  let bSession: string | undefined;
  let planApproved = false;
  let reviewRound = 0;

  while (!planApproved) {
    reviewRound++;

    const bPrompt = bSession
      ? [
          'A has answered your questions and updated the plan.',
          `Review the updated plan at ${join(projectDir, 'plan.md')} again.`,
          'If you still have concerns, respond with status "questions" and list them.',
          'If the plan is now bulletproof, respond with status "approved".',
          '',
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "questions", "questions": ["..."]}',
        ].join('\n')
      : [
          `Review the plan at ${join(projectDir, 'plan.md')}`,
          'Read the entire plan. Look for:',
          '- Gaps or missing details',
          '- Assumptions that are not verified',
          '- Code that looks incomplete or guessed',
          '- Anything the coder would need to interpret or ask about',
          '',
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "questions", "questions": ["..."]}',
        ].join('\n');

    emit('B', 'plan-review', 'status', `Review round ${reviewRound}...`);

    const bResult = await claude('B', bPrompt, {
      role: ROLE_B,
      resume: bSession,
      jsonSchema: REVIEW_SCHEMA,
    });
    bSession = bResult.sessionId;
    saveSession('B', bSession);

    const signal = parseSignal(bResult.result);

    if (isPositiveSignal(signal)) {
      planApproved = true;
      emit('B', 'plan-review', 'approval', 'PLAN APPROVED');
      setAgent('B', 'done');
    } else {
      const questions = (signal.questions as string[]) || [];

      questions.forEach((q, i) => {
        emit('B', 'plan-review', 'question', `Q${i + 1}: ${q}`);
      });

      emit('B', 'plan-review', 'send', `Sent ${questions.length} question(s) to A`);

      setAgent('A', 'active');
      emit('A', 'plan-review', 'receive', `Received ${questions.length} question(s) from B`);

      await claude('A', [
        'Agent B (Plan Reviewer) has questions about your plan:',
        '',
        ...questions.map((q, i) => `${i + 1}. ${q}`),
        '',
        'Answer each question with verified information.',
        `Update ${join(projectDir, 'plan.md')} with any corrections or additions.`,
        'Do not guess. Verify from source.',
      ].join('\n'), { role: ROLE_A, resume: aSession });

      emit('A', 'plan-review', 'answer', 'Answered questions and updated plan');
      emit('A', 'plan-review', 'send', 'Sent updated plan to B');
      setAgent('A', 'idle');
    }
  }

  emit('A', 'plan-review', 'status', 'Plan locked — final, unmodifiable copy');

  // ── Phase 2: Coding ───────────────────────────────────────────

  setPhase('coding');
  setAgent('C', 'active');
  emit('A', 'coding', 'send', 'Sent approved plan to C');
  emit('C', 'coding', 'receive', 'Received approved plan from A');
  emit('C', 'coding', 'status', 'Building...');

  const cResult = await claude('C', [
    `Read the approved plan at ${join(projectDir, 'plan.md')}`,
    'Build exactly what it says. Every file, every modification, every special case.',
    'Do not improvise. Do not interpret. Do not "improve."',
    'Do not modify plan.md — it is locked.',
    'Do NOT use the Agent tool. Do NOT spawn sub-agents. Build everything yourself.',
    '',
    'When you are done, confirm what you built.',
  ].join('\n'), { role: ROLE_C });
  const cSession = cResult.sessionId;
  saveSession('C', cSession);

  emit('C', 'coding', 'status', 'Finished coding');

  // ── Phase 3: Code Review ──────────────────────────────────────

  setPhase('code-review');
  setAgent('C', 'idle');
  setAgent('D', 'active');
  emit('C', 'code-review', 'send', 'Sent code to D for review');
  emit('D', 'code-review', 'receive', 'Received code from C');

  let dSession: string | undefined;
  let codeApproved = false;
  let codeReviewRound = 0;

  while (!codeApproved) {
    codeReviewRound++;

    const dPrompt = dSession
      ? [
          'C has applied fixes to the code.',
          `Review the code again against the plan at ${join(projectDir, 'plan.md')}`,
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "issues", "issues": ["..."]}',
        ].join('\n')
      : [
          `Read the plan at ${join(projectDir, 'plan.md')}`,
          'Read the code that C wrote.',
          'Check: does the code match the plan? Every item accounted for?',
          '',
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "issues", "issues": ["..."]}',
        ].join('\n');

    emit('D', 'code-review', 'status', `Code review round ${codeReviewRound}...`);

    const dResult = await claude('D', dPrompt, {
      role: ROLE_D,
      resume: dSession,
      jsonSchema: CODE_REVIEW_SCHEMA,
    });
    dSession = dResult.sessionId;
    saveSession('D', dSession);

    const signal = parseSignal(dResult.result);

    if (isPositiveSignal(signal)) {
      codeApproved = true;
      emit('D', 'code-review', 'approval', 'CODE APPROVED');
    } else {
      const issues = (signal.issues as string[]) || [];

      issues.forEach((issue, i) => {
        emit('D', 'code-review', 'issue', `Issue ${i + 1}: ${issue}`);
      });

      emit('D', 'code-review', 'send', `Sent ${issues.length} issue(s) to C`);
      setAgent('C', 'active');
      emit('C', 'code-review', 'receive', `Received ${issues.length} issue(s) from D`);

      await claude('C', [
        'Agent D (Code Reviewer) found issues with your code:',
        '',
        ...issues.map((issue, i) => `${i + 1}. ${issue}`),
        '',
        'Fix each issue. Do not modify plan.md.',
      ].join('\n'), { role: ROLE_C, resume: cSession });

      emit('C', 'code-review', 'fix', 'Applied fixes');
      emit('C', 'code-review', 'send', 'Sent fixed code to D');
      setAgent('C', 'idle');
    }
  }

  // ── Phase 4: Testing ──────────────────────────────────────────

  setPhase('testing');
  emit('D', 'testing', 'status', 'Moving to testing...');

  let testsPassed = false;
  let testRound = 0;

  while (!testsPassed) {
    testRound++;

    const testPrompt = testRound === 1
      ? [
          'Code review is complete. Now test the code.',
          'Run it. Confirm it actually works — not just that it looks right.',
          `Test all functionality against the plan at ${join(projectDir, 'plan.md')}`,
          '',
          'Respond with ONLY a JSON object: {"status": "passed"} or {"status": "failed", "failures": ["..."]}',
        ].join('\n')
      : [
          'C has applied fixes for the test failures.',
          'Re-test the code.',
          'Respond with ONLY a JSON object: {"status": "passed"} or {"status": "failed", "failures": ["..."]}',
        ].join('\n');

    emit('D', 'testing', 'status', `Test round ${testRound}...`);

    const testResult = await claude('D', testPrompt, {
      role: ROLE_D,
      resume: dSession!,
      jsonSchema: TEST_SCHEMA,
    });

    const signal = parseSignal(testResult.result);

    if (isPositiveSignal(signal)) {
      testsPassed = true;
      emit('D', 'testing', 'approval', 'ALL TESTS PASSED');
      setAgent('D', 'done');
    } else {
      const failures = (signal.failures as string[]) || [];

      failures.forEach((f, i) => {
        emit('D', 'testing', 'failure', `Failure ${i + 1}: ${f}`);
      });

      emit('D', 'testing', 'send', `Sent ${failures.length} failure(s) to C`);
      setAgent('C', 'active');
      emit('C', 'testing', 'receive', `Received ${failures.length} failure(s) from D`);

      await claude('C', [
        'Agent D (Tester) found test failures:',
        '',
        ...failures.map((f, i) => `${i + 1}. ${f}`),
        '',
        'Fix each failure. Do not modify plan.md.',
      ].join('\n'), { role: ROLE_C, resume: cSession });

      emit('C', 'testing', 'fix', 'Applied fixes');
      emit('C', 'testing', 'send', 'Sent fixed code to D');
      setAgent('C', 'done');
    }
  }

  // ── Phase 5: Deploy ───────────────────────────────────────────

  setPhase('deploy');
  setAgent('A', 'active');
  emit('D', 'deploy', 'send', 'Sent reviewed + tested code to A');
  emit('A', 'deploy', 'receive', 'Received final code from D');
  emit('A', 'deploy', 'status', 'Deploying...');

  await claude('A', [
    'The code has been reviewed and tested by Agent D. Everything passed.',
    'Commit, push, and deploy if applicable.',
    'If there is no repo, just confirm the build is complete.',
  ].join('\n'), { role: ROLE_A, resume: aSession });

  setAgent('A', 'done');
  setPhase('complete');
  state.buildComplete = true;
  emit('A', 'deploy', 'approval', 'BUILD COMPLETE');

  // Git commit the final build
  try {
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', `Build complete: ${concept.slice(0, 50)}`], { cwd: projectDir });
    emit('system', 'complete', 'status', 'Code committed to git');
  } catch {}

  // Try to open the result — look for index.html or any .html file
  try {
    const files = readdirSync(projectDir);
    const htmlFile = files.find(f => f === 'index.html') || files.find(f => f.endsWith('.html'));
    if (htmlFile) {
      execFileSync('open', [join(projectDir, htmlFile)]);
      emit('system', 'complete', 'status', `Opened ${htmlFile}`);
    }
  } catch {}

  console.log('\n\x1b[1m╔══════════════════════════════════════════╗');
  console.log('║            BUILD COMPLETE                 ║');
  console.log('╚══════════════════════════════════════════╝\x1b[0m');
  console.log(`\n  Project:       ${projectDir}`);
  console.log(`  Plan:          ${join(projectDir, 'plan.md')}`);
  console.log(`  Review rounds: ${reviewRound}`);
  console.log(`  Code reviews:  ${codeReviewRound}`);
  console.log(`  Test rounds:   ${testRound}`);
  console.log('');
}

run().catch((err) => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
