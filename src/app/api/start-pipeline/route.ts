import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { NextRequest, NextResponse } from 'next/server';

const BUILDUI_DIR = resolve(process.cwd(), 'pipeline');
const BUILDS_DIR = join(homedir(), 'Builds');
const STAGING_DIR = join(BUILDS_DIR, '.staging');

let orchestratorProcess: ReturnType<typeof spawn> | null = null;

export async function POST(req: NextRequest) {
  if (orchestratorProcess) {
    return NextResponse.json({ success: false, error: 'Pipeline already running' });
  }

  let securityMode = 'fast';
  try {
    const body = await req.json();
    if (body?.securityMode === 'strict') securityMode = 'strict';
  } catch {}

  // Read staging state — this is where Phase 0 chat lives
  const stagingEvents = join(STAGING_DIR, 'pipeline-events.json');
  if (!existsSync(stagingEvents)) {
    return NextResponse.json({ success: false, error: 'No staging session found. Chat with Agent A first.' });
  }

  let stagingState: Record<string, unknown>;
  try {
    stagingState = JSON.parse(readFileSync(stagingEvents, 'utf8'));
  } catch {
    return NextResponse.json({ success: false, error: 'Could not read staging state' });
  }

  const concept = (stagingState.concept as string) || '';
  const sessions = (stagingState.sessions as Record<string, string>) || {};
  const aSession = sessions.A || '';

  if (!aSession) {
    return NextResponse.json({ success: false, error: 'No Agent A session found. Chat with A first.' });
  }

  // Create real project directory from concept
  const projectName = (concept || 'new-build')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  const projectDir = join(BUILDS_DIR, projectName);
  mkdirSync(projectDir, { recursive: true });

  // Copy templates
  const templates = ['checklist-template.md', 'build-plan-template.md'];
  for (const t of templates) {
    const src = join(BUILDUI_DIR, t);
    const dst = join(projectDir, t.replace('-template', ''));
    if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst);
  }

  // Copy hooks
  mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
  const settingsSrc = join(BUILDUI_DIR, '.claude', 'settings.json');
  const hookSrc = join(BUILDUI_DIR, '.claude', 'hooks', 'approval-gate.sh');
  if (existsSync(settingsSrc)) copyFileSync(settingsSrc, join(projectDir, '.claude', 'settings.json'));
  if (existsSync(hookSrc)) {
    copyFileSync(hookSrc, join(projectDir, '.claude', 'hooks', 'approval-gate.sh'));
    try { execFileSync('chmod', ['+x', join(projectDir, '.claude', 'hooks', 'approval-gate.sh')]); } catch {}
  }

  // Move staging state to real project, update projectDir
  stagingState.projectDir = projectDir;
  stagingState.securityMode = securityMode;
  writeFileSync(join(projectDir, 'pipeline-events.json'), JSON.stringify(stagingState, null, 2));

  // Clear staging
  try { rmSync(STAGING_DIR, { recursive: true, force: true }); } catch {}

  // Spawn orchestrator
  const orchestratorPath = join(BUILDUI_DIR, 'orchestrator.ts');
  orchestratorProcess = spawn('npx', ['tsx', orchestratorPath, '--project-dir', projectDir, '--a-session', aSession], {
    cwd: projectDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, PIPELINE_SECURITY_MODE: securityMode },
  });

  orchestratorProcess.stdout?.on('data', (data) => process.stdout.write(data));
  orchestratorProcess.stderr?.on('data', (data) => process.stderr.write(data));
  orchestratorProcess.on('close', () => { orchestratorProcess = null; });

  return NextResponse.json({ success: true, projectDir, securityMode });
}
