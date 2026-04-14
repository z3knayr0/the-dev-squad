import assert from 'node:assert/strict';

import {
  MAX_AUTO_RESUMES,
  TURN_IDLE_TIMEOUT_MS,
  buildResumePrompt,
  canAutoResumeTurn,
  shouldMarkTurnStalled,
  summarizePrompt,
} from '../src/lib/pipeline-runtime.ts';

assert.equal(summarizePrompt('short prompt'), 'short prompt');
assert.equal(
  summarizePrompt('This is a deliberately long prompt that should be trimmed down for runtime display in the dashboard.', 40),
  'This is a deliberately long prompt th...'
);

assert.equal(canAutoResumeTurn('A', 'planning'), true);
assert.equal(canAutoResumeTurn('A', 'plan-review'), true);
assert.equal(canAutoResumeTurn('B', 'plan-review'), true);
assert.equal(canAutoResumeTurn('C', 'coding'), false);

assert.equal(shouldMarkTurnStalled(0, TURN_IDLE_TIMEOUT_MS - 1), false);
assert.equal(shouldMarkTurnStalled(0, TURN_IDLE_TIMEOUT_MS), true);

assert.match(buildResumePrompt('A', 'planning'), /Do not repeat research/i);
assert.match(buildResumePrompt('B', 'plan-review'), /Output your verdict immediately|approved|questions/i);
assert.equal(MAX_AUTO_RESUMES, 3);

console.log('pipeline-runtime checks passed');
