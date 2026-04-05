import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AutoRunner,
  DockerRunner,
  HostRunner,
  buildClaudeArgs,
  buildDockerArgs,
  buildRunnerEnv,
  createCredentialBootstrap,
  createRunner,
  getNetworkProfile,
  getProjectMountMode,
  hasUsableCredentialsFile,
  isRecoverableDockerAuthFailure,
  shouldPreferDocker,
} from '../pipeline/runner.ts';

const roleArgs = buildClaudeArgs({
  prompt: 'build me a tiny app',
  projectDir: '/tmp/project',
  model: 'claude-opus-4-6',
  roleFile: '/tmp/role.md',
  resume: 'sess-123',
  effort: 'high',
  jsonSchema: { type: 'object' },
});

assert.equal(roleArgs[0], '-p');
assert.equal(roleArgs[1], 'build me a tiny app');
assert.ok(
  roleArgs.includes('--permission-mode') || roleArgs.includes('--dangerously-skip-permissions'),
  'permission flag present',
);
assert.ok(roleArgs.includes('--model'));
assert.ok(roleArgs.includes('--output-format'));
assert.ok(roleArgs.includes('--system-prompt-file'));
assert.ok(roleArgs.includes('/tmp/role.md'));
assert.ok(roleArgs.includes('--resume'));
assert.ok(roleArgs.includes('sess-123'));
assert.ok(roleArgs.includes('--effort'));
assert.ok(roleArgs.includes('high'));
assert.ok(roleArgs.includes('--json-schema'));

const promptArgs = buildClaudeArgs({
  prompt: 'hello',
  projectDir: '/tmp/project',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are helpful.',
});
assert.ok(promptArgs.includes('--system-prompt'));
assert.ok(promptArgs.includes('You are helpful.'));

const env = buildRunnerEnv({
  prompt: 'hello',
  projectDir: '/tmp/project',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are helpful.',
  pipelineAgent: 'C',
  securityMode: 'strict',
  extraEnv: { TEST_ONLY: '1' },
});
assert.equal(env.PIPELINE_AGENT, 'C');
assert.equal(env.PIPELINE_SECURITY_MODE, 'strict');
assert.equal(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, '1');
assert.equal(env.TEST_ONLY, '1');

assert.equal(shouldPreferDocker({ pipelineAgent: 'C' }), true);
assert.equal(shouldPreferDocker({ pipelineAgent: 'D' }), true);
assert.equal(shouldPreferDocker({ pipelineAgent: 'A' }), false);
assert.equal(getProjectMountMode('B'), 'ro');
assert.equal(getProjectMountMode('D'), 'rw');
assert.equal(getNetworkProfile('A'), 'research');
assert.equal(getNetworkProfile('C'), 'build');
assert.equal(getNetworkProfile('S'), 'none');
assert.equal(isRecoverableDockerAuthFailure('Not logged in · Please run /login'), true);
assert.equal(isRecoverableDockerAuthFailure('Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'), true);
assert.equal(isRecoverableDockerAuthFailure('Tool execution failed for a different reason'), false);

const credentialsTmp = mkdtempSync(join(tmpdir(), 'runner-creds-'));
const placeholderPath = join(credentialsTmp, 'placeholder.json');
const realCredsPath = join(credentialsTmp, 'real.json');
writeFileSync(placeholderPath, '{}');
writeFileSync(realCredsPath, '{"oauth_token":"abc"}');
assert.equal(hasUsableCredentialsFile(join(credentialsTmp, 'missing.json')), false);
assert.equal(hasUsableCredentialsFile(placeholderPath), false);
assert.equal(hasUsableCredentialsFile(realCredsPath), true);

const bootstrap = createCredentialBootstrap(
  '{"oauth_token":"abc"}',
  'macos-keychain',
  '{"hasCompletedOnboarding":true}'
);
assert.equal(bootstrap.source, 'macos-keychain');
assert.equal(bootstrap.mountArgs.length, 2);
assert.ok(bootstrap.mountArgs[1].includes('/home/node/.claude/.credentials.json:ro'));
assert.match(readFileSync(bootstrap.mountArgs[1].split(':')[0], 'utf8'), /oauth_token/);
const dockerArgs = buildDockerArgs({
  prompt: 'Reply with OK.',
  projectDir: '/tmp/project',
  pipelineDir: '/tmp/pipeline',
  model: 'claude-sonnet-4-6',
  roleFile: '/tmp/role.md',
  pipelineAgent: 'C',
  securityMode: 'fast',
}, bootstrap);
assert.equal(dockerArgs[0], 'run');
assert.equal(dockerArgs[1], '--rm');
assert.ok(!dockerArgs.includes('-i'));
assert.ok(dockerArgs.includes('dev-squad-agent:latest'));
assert.ok(dockerArgs.includes('/usr/local/share/npm-global/bin/claude'));
assert.ok(!dockerArgs.includes('sh'));
assert.ok(!dockerArgs.includes('-lc'));
assert.ok(!dockerArgs.includes('ANTHROPIC_API_KEY'));

const dockerArgsWithAuth = buildDockerArgs({
  prompt: 'Reply with OK.',
  projectDir: '/tmp/project',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are helpful.',
  extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'token-123' },
}, bootstrap);
assert.ok(dockerArgsWithAuth.includes('CLAUDE_CODE_OAUTH_TOKEN'));
bootstrap.cleanup();
rmSync(credentialsTmp, { recursive: true, force: true });

assert.ok(createRunner('host') instanceof HostRunner);
assert.ok(createRunner('auto') instanceof AutoRunner);
assert.equal(typeof new DockerRunner().isAvailable(), 'boolean');
assert.equal(new HostRunner().supportsHostFallback({ pipelineAgent: 'C' }), false);
assert.equal(new AutoRunner().supportsHostFallback({ pipelineAgent: 'C' }), true);
assert.equal(new AutoRunner().supportsHostFallback({ pipelineAgent: 'C', forceHost: true }), false);

console.log('runner checks passed');
