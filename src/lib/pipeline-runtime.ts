export type TurnStatus = 'running' | 'stalled';

export interface ActiveTurnState {
  agent: string;
  phase: string;
  status: TurnStatus;
  startedAt: string;
  lastEventAt: string;
  sessionId: string;
  promptSummary: string;
  autoResumeCount: number;
  stalledAt?: string;
  stallReason?: string;
}

export interface PipelineRuntimeState {
  activeTurn: ActiveTurnState | null;
}

export const EMPTY_RUNTIME: PipelineRuntimeState = {
  activeTurn: null,
};

export const TURN_IDLE_TIMEOUT_MS = 300_000;
export const MAX_AUTO_RESUMES = 3;

export function summarizePrompt(prompt: string, maxLength: number = 140): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 3) + '...';
}

export function canAutoResumeTurn(agent: string, phase: string): boolean {
  return (agent === 'A' && (phase === 'planning' || phase === 'plan-review')) ||
    (agent === 'B' && phase === 'plan-review');
}

export function shouldMarkTurnStalled(lastEventAtMs: number, nowMs: number, idleTimeoutMs: number = TURN_IDLE_TIMEOUT_MS): boolean {
  return nowMs - lastEventAtMs >= idleTimeoutMs;
}

export function buildResumePrompt(agent: string, phase: string): string {
  if (agent === 'A' && phase === 'planning') {
    return [
      'Your previous planning turn stalled mid-task.',
      'Continue from the last unfinished step only.',
      'Do not repeat research or reread everything from scratch unless absolutely necessary.',
      'If research is already complete, immediately write or finish plan.md, do one self-review pass, and stop.',
    ].join(' ');
  }

  if (agent === 'A' && phase === 'plan-review') {
    return [
      'Your previous plan-review response stalled mid-task.',
      'Continue from the last unfinished answer only.',
      'Do not restart the whole review loop from scratch.',
      'Update plan.md only if B asked for a correction, then finish your response.',
    ].join(' ');
  }

  if (agent === 'B' && phase === 'plan-review') {
    return [
      'Your previous review turn stalled mid-task.',
      'Do not restart the review or summarize the plan.',
      'Output your verdict immediately: {"status": "approved"} or {"status": "questions", "questions": ["..."]}.',
      'Nothing else.',
    ].join(' ');
  }

  return [
    'Your previous turn stalled mid-task.',
    'Continue from the last unfinished step only.',
    'Do not repeat completed work unless absolutely necessary.',
  ].join(' ');
}
