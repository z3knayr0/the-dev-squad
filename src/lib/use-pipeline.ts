'use client';

import { useEffect, useState, useCallback } from 'react';

export type AgentId = 'A' | 'B' | 'C' | 'D' | 'S';
export type Phase = 'concept' | 'planning' | 'plan-review' | 'coding' | 'code-review' | 'testing' | 'deploy' | 'complete';
export type AppMode = 'pipeline' | 'manual';

export interface PipelineEvent {
  time: string;
  agent: AgentId | 'system';
  phase: string;
  type: string;
  text: string;
  detail?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
}

export interface PipelineState {
  concept: string;
  projectDir: string;
  currentPhase: Phase;
  activeAgent: string;
  agentStatus: Record<AgentId, string>;
  sessions: Record<string, string>;
  buildComplete: boolean;
  usage: TokenUsage;
  events: PipelineEvent[];
}

const EMPTY_STATE: PipelineState = {
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

interface UsePipelineOptions {
  pollInterval?: number;
  mode: AppMode;
  model: string;
}

export function usePipelineState({ pollInterval = 400, mode, model }: UsePipelineOptions) {
  const [state, setState] = useState<PipelineState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const res = await fetch(`/api/state?mode=${mode}&_=${Date.now()}`);
        if (!res.ok) return;
        const data = await res.json();
        if (active) {
          setState(data);
          setError(null);
        }
      } catch (err) {
        if (active) setError(String(err));
      }
    }

    poll();
    const interval = setInterval(poll, pollInterval);
    return () => { active = false; clearInterval(interval); };
  }, [pollInterval, mode]);

  const sendChat = useCallback(async (agent: AgentId, message: string) => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, message, mode, model }),
    });
    return res.json();
  }, [mode, model]);

  const startPipeline = useCallback(async () => {
    const res = await fetch('/api/start-pipeline', { method: 'POST' });
    return res.json();
  }, []);

  const stopPipeline = useCallback(async () => {
    const res = await fetch('/api/stop-pipeline', { method: 'POST' });
    return res.json();
  }, []);

  const approveBash = useCallback(async (approved: boolean) => {
    const res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    });
    return res.json();
  }, []);

  const getPlan = useCallback(async () => {
    const res = await fetch('/api/plan');
    if (!res.ok) return null;
    const data = await res.json();
    return data.content as string | null;
  }, []);

  const resetState = useCallback(async () => {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    return res.json();
  }, [mode]);

  // Get events for a specific agent
  const agentEvents = useCallback((agent: AgentId) => {
    return state.events.filter(e => e.agent === agent);
  }, [state.events]);

  // Get latest speech for an agent (for bubble display)
  const agentSpeech = useCallback((agent: AgentId): string | null => {
    const events = state.events.filter(e => e.agent === agent && (e.type === 'text' || e.type === 'status' || e.type === 'tool_call'));
    if (events.length === 0) return null;
    const last = events[events.length - 1];
    return last.text.length > 80 ? last.text.slice(0, 77) + '...' : last.text;
  }, [state.events]);

  return {
    state,
    error,
    sendChat,
    startPipeline,
    stopPipeline,
    approveBash,
    getPlan,
    resetState,
    agentEvents,
    agentSpeech,
  };
}
