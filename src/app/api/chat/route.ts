import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { NextRequest, NextResponse } from 'next/server';

const BUILDUI_DIR = resolve(process.cwd(), 'pipeline');
const BUILDS_DIR = join(homedir(), 'Builds');
const STAGING_DIR = join(BUILDS_DIR, '.staging');
const MANUAL_DIR = join(BUILDS_DIR, '.manual');
const ROLE_A_PHASE0 = join(BUILDUI_DIR, 'role-a-phase0.md');
const ROLE_FILES: Record<string, string> = {
  A: join(BUILDUI_DIR, 'role-a.md'),
  B: join(BUILDUI_DIR, 'role-b.md'),
  C: join(BUILDUI_DIR, 'role-c.md'),
  D: join(BUILDUI_DIR, 'role-d.md'),
  S: join(BUILDUI_DIR, 'role-s.md'),
};

const MANUAL_PROMPTS: Record<string, string> = {
  A: 'You specialize in software planning and architecture.',
  B: 'You specialize in code review and finding gaps.',
  C: 'You specialize in writing code.',
  D: 'You specialize in testing and debugging.',
  S: 'You help oversee and diagnose issues.',
};

function getManualState(): Record<string, unknown> {
  const eventsFile = join(MANUAL_DIR, 'manual-state.json');
  if (existsSync(eventsFile)) {
    try { return JSON.parse(readFileSync(eventsFile, 'utf8')); } catch {}
  }
  mkdirSync(MANUAL_DIR, { recursive: true });
  const fresh: Record<string, unknown> = {
    concept: '',
    projectDir: MANUAL_DIR,
    currentPhase: 'concept',
    activeAgent: '',
    agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    sessions: {},
    buildComplete: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    events: [],
  };
  writeFileSync(eventsFile, JSON.stringify(fresh, null, 2));
  return fresh;
}

function getStagingState(): Record<string, unknown> {
  const eventsFile = join(STAGING_DIR, 'pipeline-events.json');
  if (existsSync(eventsFile)) {
    try { return JSON.parse(readFileSync(eventsFile, 'utf8')); } catch {}
  }
  mkdirSync(STAGING_DIR, { recursive: true });
  const fresh: Record<string, unknown> = {
    concept: '',
    projectDir: '',
    currentPhase: 'concept',
    activeAgent: '',
    agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    sessions: {},
    buildComplete: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    events: [],
  };
  writeFileSync(eventsFile, JSON.stringify(fresh, null, 2));
  return fresh;
}

function findLatestProject(): string | null {
  try {
    const { readdirSync, statSync } = require('fs');
    const dirs = readdirSync(BUILDS_DIR)
      .filter((name: string) => name !== '.staging' && name !== '.manual')
      .map((name: string) => join(BUILDS_DIR, name))
      .filter((p: string) => {
        try { return statSync(p).isDirectory() && statSync(join(p, 'pipeline-events.json')).isFile(); }
        catch { return false; }
      })
      .sort((a: string, b: string) => statSync(join(b, 'pipeline-events.json')).mtimeMs - statSync(join(a, 'pipeline-events.json')).mtimeMs);
    return dirs[0] || null;
  } catch { return null; }
}

// ── Shared: stream claude output into a state file ──────────────────

function streamClaude(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  eventsFile: string,
  agent: string,
  sessionId: string,
): Promise<NextResponse> {
  return new Promise<NextResponse>((resolveResponse) => {
    const child = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    const rl = createInterface({ input: child.stdout });
    let newSessionId = sessionId;

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { return; }

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
            if (toolName === 'Read' && input.file_path) desc = `Reading: ${basename(input.file_path as string)}`;
            else if (toolName === 'Write' && input.file_path) desc = `Writing: ${basename(input.file_path as string)}`;
            else if (toolName === 'Edit' && input.file_path) desc = `Editing: ${basename(input.file_path as string)}`;
            else if (toolName === 'Bash' && input.command) desc = `Running: ${(input.command as string).slice(0, 80)}`;

            try {
              const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
              s.events.push({ time: new Date().toISOString(), agent, phase: s.currentPhase || 'concept', type: 'tool_call', text: desc });
              writeFileSync(eventsFile, JSON.stringify(s, null, 2));
            } catch {}
          } else if (block.type === 'text') {
            const text = ((block.text as string) || '').trim();
            if (text) {
              try {
                const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
                s.events.push({ time: new Date().toISOString(), agent, phase: s.currentPhase || 'concept', type: 'text', text });
                writeFileSync(eventsFile, JSON.stringify(s, null, 2));
              } catch {}
            }
          }
        }
      } else if (type === 'result') {
        newSessionId = (event.session_id as string) || sessionId;
        try {
          const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
          if (!s.sessions) s.sessions = {};
          s.sessions[agent] = newSessionId;
          const usage = event.usage as Record<string, number>;
          if (usage && s.usage) {
            s.usage.inputTokens = (s.usage.inputTokens || 0) + (usage.input_tokens || 0);
            s.usage.outputTokens = (s.usage.outputTokens || 0) + (usage.output_tokens || 0);
            s.usage.cacheReadTokens = (s.usage.cacheReadTokens || 0) + (usage.cache_read_input_tokens || 0);
            s.usage.cacheWriteTokens = (s.usage.cacheWriteTokens || 0) + (usage.cache_creation_input_tokens || 0);
          }
          const cost = event.total_cost_usd as number;
          if (cost && s.usage) s.usage.totalCostUsd = (s.usage.totalCostUsd || 0) + cost;
          writeFileSync(eventsFile, JSON.stringify(s, null, 2));
        } catch {}
      }
    });

    child.on('close', () => {
      // Set agent back to idle
      try {
        const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
        if (s.agentStatus) s.agentStatus[agent] = 'idle';
        writeFileSync(eventsFile, JSON.stringify(s, null, 2));
      } catch {}
      resolveResponse(NextResponse.json({ success: true, sessionId: newSessionId }));
    });
    child.on('error', () => {
      resolveResponse(NextResponse.json({ success: false }, { status: 500 }));
    });
  });
}

// ── Manual mode ─────────────────────────────────────────────────────

function handleManual(agent: string, message: string, model: string) {
  const eventsFile = join(MANUAL_DIR, 'manual-state.json');
  const state = getManualState();
  const sessions = (state.sessions as Record<string, string>) || {};
  const sessionId = sessions[agent] || '';

  // Set agent active
  const agentStatus = (state.agentStatus as Record<string, string>) || {};
  agentStatus[agent] = 'active';
  state.agentStatus = agentStatus;

  // Append user message
  const events = (state.events as Array<Record<string, unknown>>) || [];
  events.push({ time: new Date().toISOString(), agent, phase: 'concept', type: 'user_msg', text: `You: ${message}` });
  state.events = events;
  writeFileSync(eventsFile, JSON.stringify(state, null, 2));

  const safeMessage = message.startsWith('-') ? 'User says: ' + message : message;

  const args: string[] = [
    '-p', safeMessage,
    '--permission-mode', 'auto',
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (sessionId) {
    args.push('--resume', sessionId);
  } else {
    args.push('--system-prompt', MANUAL_PROMPTS[agent] || MANUAL_PROMPTS.A);
  }

  return streamClaude(args, MANUAL_DIR, { ...process.env }, eventsFile, agent, sessionId);
}

// ── Pipeline mode ───────────────────────────────────────────────────

function handlePipeline(agent: string, message: string) {
  let projectDir: string;
  let eventsFile: string;

  const stagingEvents = join(STAGING_DIR, 'pipeline-events.json');
  const activeProject = findLatestProject();

  if (existsSync(stagingEvents)) {
    projectDir = STAGING_DIR;
    eventsFile = stagingEvents;
  } else if (activeProject) {
    const projState = JSON.parse(readFileSync(join(activeProject, 'pipeline-events.json'), 'utf8'));
    const phase = projState.currentPhase as string;
    const isActive = phase && phase !== 'concept' && !projState.buildComplete;
    const isDone = !!projState.buildComplete;
    if (isActive || isDone) {
      projectDir = activeProject;
      eventsFile = join(activeProject, 'pipeline-events.json');
    } else {
      projectDir = STAGING_DIR;
      eventsFile = stagingEvents;
      getStagingState();
    }
  } else {
    projectDir = STAGING_DIR;
    eventsFile = stagingEvents;
    getStagingState();
  }

  let state: Record<string, unknown> = {};
  try { state = JSON.parse(readFileSync(eventsFile, 'utf8')); } catch {}
  const sessions = (state.sessions as Record<string, string>) || {};
  const sessionId = sessions[agent] || '';

  if (!state.concept && message) {
    state.concept = message;
    writeFileSync(eventsFile, JSON.stringify(state, null, 2));
  }

  const currentPhase = state.currentPhase as string;
  const isPhase0 = !currentPhase || currentPhase === 'concept';
  const roleFile = (agent === 'A' && isPhase0) ? ROLE_A_PHASE0 : (ROLE_FILES[agent] || ROLE_FILES.A);

  const safeMessage = message.startsWith('-') ? 'User says: ' + message : message;
  const buildComplete = !!state.buildComplete;
  let finalMessage = safeMessage;
  if (buildComplete) {
    finalMessage = '[The build pipeline has completed. The user is chatting with you directly for post-build work — reviewing, fixing, or modifying the project.]\n\n' + safeMessage;
  }

  const events = (state.events as Array<Record<string, unknown>>) || [];
  events.push({ time: new Date().toISOString(), agent, phase: state.currentPhase || 'concept', type: 'user_msg', text: `You: ${message}` });
  state.events = events;
  writeFileSync(eventsFile, JSON.stringify(state, null, 2));

  const args: string[] = [
    '-p', finalMessage,
    '--system-prompt-file', roleFile,
    '--permission-mode', 'auto',
    '--model', 'claude-opus-4-6',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (sessionId) args.push('--resume', sessionId);

  return streamClaude(args, projectDir, { ...process.env, PIPELINE_AGENT: agent }, eventsFile, agent, sessionId);
}

// ── Route handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { agent, message, mode, model } = await req.json();

  if (mode === 'manual') {
    return handleManual(agent, message, model || 'claude-sonnet-4-6');
  }
  return handlePipeline(agent, message);
}
