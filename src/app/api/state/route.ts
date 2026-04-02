import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { NextRequest, NextResponse } from 'next/server';

const BUILDS_DIR = join(homedir(), 'Builds');
const STAGING_DIR = join(BUILDS_DIR, '.staging');
const MANUAL_DIR = join(BUILDS_DIR, '.manual');

const EMPTY_STATE = {
  concept: '', projectDir: '', currentPhase: 'concept', activeAgent: '',
  agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
  sessions: {}, buildComplete: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
  events: [],
};

function findLatestProject(): string | null {
  try {
    const dirs = readdirSync(BUILDS_DIR)
      .filter(name => name !== '.staging' && name !== '.manual')
      .map(name => join(BUILDS_DIR, name))
      .filter(p => {
        try { return statSync(p).isDirectory() && statSync(join(p, 'pipeline-events.json')).isFile(); }
        catch { return false; }
      })
      .sort((a, b) => statSync(join(b, 'pipeline-events.json')).mtimeMs - statSync(join(a, 'pipeline-events.json')).mtimeMs);
    return dirs[0] || null;
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') || 'pipeline';

  // Manual mode — read from .manual directory
  if (mode === 'manual') {
    const manualEvents = join(MANUAL_DIR, 'manual-state.json');
    if (existsSync(manualEvents)) {
      try {
        const data = readFileSync(manualEvents, 'utf8');
        return NextResponse.json(JSON.parse(data));
      } catch {}
    }
    return NextResponse.json(EMPTY_STATE);
  }

  // Pipeline mode — check staging first, then real projects
  const stagingEvents = join(STAGING_DIR, 'pipeline-events.json');
  if (existsSync(stagingEvents)) {
    try {
      const data = readFileSync(stagingEvents, 'utf8');
      return NextResponse.json(JSON.parse(data));
    } catch {}
  }

  const projectDir = findLatestProject();
  if (!projectDir) {
    return NextResponse.json(EMPTY_STATE);
  }

  try {
    const data = JSON.parse(readFileSync(join(projectDir, 'pipeline-events.json'), 'utf8'));
    const phase = data.currentPhase as string;
    const isActive = phase && phase !== 'concept' && !data.buildComplete;
    const isDone = !!data.buildComplete;
    if (isActive || isDone) {
      return NextResponse.json(data);
    }
    return NextResponse.json(EMPTY_STATE);
  } catch {
    return NextResponse.json(EMPTY_STATE);
  }
}
