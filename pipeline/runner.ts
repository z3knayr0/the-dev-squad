import { execFileSync, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export type PipelineAgentId = 'A' | 'B' | 'C' | 'D' | 'S';
export type RunnerMode = 'host' | 'docker' | 'auto';
export type RunnerBackend = 'host' | 'docker';

export interface RunnerOptions {
  prompt: string;
  projectDir: string;
  pipelineDir?: string;
  model: string;
  roleFile?: string;
  systemPrompt?: string;
  resume?: string;
  jsonSchema?: Record<string, unknown>;
  effort?: string;
  pipelineAgent?: PipelineAgentId;
  securityMode?: 'fast' | 'strict';
  extraEnv?: NodeJS.ProcessEnv;
  templateFiles?: string[];
  forceHost?: boolean;
}

export type RunnerChild = Pick<
  ChildProcessWithoutNullStreams,
  'stdout' | 'stderr' | 'on' | 'kill'
>;

export type SpawnedRunnerChild = RunnerChild & {
  backend: RunnerBackend;
};

export interface Runner {
  spawn(opts: RunnerOptions): SpawnedRunnerChild;
  cleanup(projectDir: string): Promise<void>;
  isAvailable(): boolean;
  supportsHostFallback(opts: RunnerOptions): boolean;
}

const DOCKER_IMAGE = 'dev-squad-agent:latest';
const KEYCHAIN_SERVICE_NAME = 'Claude Code-credentials';
const DOCKER_WORKSPACE_ROOT = join(tmpdir(), 'devsquad-docker-workspaces');
const DOCKER_SYNC_BACK_EXCLUDES = new Set([
  '.claude',
  '.git',
  'pipeline-approved.json',
  'pipeline-events.json',
  'pipeline-pending.json',
]);

export interface DockerCredentialBootstrap {
  source: 'none' | 'host-credentials-file' | 'macos-keychain';
  mountArgs: string[];
  cleanup: () => void;
}

interface DockerWorkspace {
  mountedProjectDir: string;
  syncBack: () => void;
  cleanup: () => void;
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function hasUsableCredentialsFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    return statSync(filePath).size > 4;
  } catch {
    return false;
  }
}

export function createCredentialBootstrap(
  credentialsJson: string,
  source: DockerCredentialBootstrap['source'],
): DockerCredentialBootstrap {
  const tempDir = mkdtempSync(join(tmpdir(), 'devsquad-claude-'));
  const claudeDir = join(tempDir, '.claude');
  const credentialsPath = join(claudeDir, '.credentials.json');

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(credentialsPath, credentialsJson, { mode: 0o600 });

  return {
    source,
    mountArgs: [
      '-v', `${credentialsPath}:/home/node/.claude/.credentials.json:ro`,
    ],
    cleanup: () => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function readMacOsKeychainCredentials(): string | null {
  if (process.platform !== 'darwin') return null;

  try {
    const output = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE_NAME, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();

    return output || null;
  } catch {
    return null;
  }
}

export function resolveDockerCredentialBootstrap(): DockerCredentialBootstrap {
  const hostCredentialsPath = join(homedir(), '.claude', '.credentials.json');
  if (hasUsableCredentialsFile(hostCredentialsPath)) {
    return createCredentialBootstrap(
      readFileSync(hostCredentialsPath, 'utf8'),
      'host-credentials-file'
    );
  }

  const keychainCredentials = readMacOsKeychainCredentials();
  if (keychainCredentials) {
    return createCredentialBootstrap(keychainCredentials, 'macos-keychain');
  }

  return {
    source: 'none',
    mountArgs: [],
    cleanup: () => {},
  };
}

function projectHash(projectDir: string): string {
  return createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
}

function getDockerWorkspaceDir(projectDir: string, agent?: PipelineAgentId): string {
  return join(
    DOCKER_WORKSPACE_ROOT,
    `${projectHash(projectDir)}-${agent || 'session'}`
  );
}

function copyDirectoryContents(sourceDir: string, targetDir: string, excludes?: Set<string>) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (excludes?.has(entry.name)) continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
      dereference: false,
    });
  }
}

function prepareDockerWorkspace(opts: RunnerOptions): DockerWorkspace {
  const mountedProjectDir = getDockerWorkspaceDir(opts.projectDir, opts.pipelineAgent);
  rmSync(mountedProjectDir, { recursive: true, force: true });
  copyDirectoryContents(opts.projectDir, mountedProjectDir);

  return {
    mountedProjectDir,
    syncBack: () => {
      if (opts.pipelineAgent !== 'C') return;
      copyDirectoryContents(mountedProjectDir, opts.projectDir, DOCKER_SYNC_BACK_EXCLUDES);
    },
    cleanup: () => {},
  };
}

export function shouldPreferDocker(opts: RunnerOptions): boolean {
  return opts.pipelineAgent === 'C' || opts.pipelineAgent === 'D';
}

export function getProjectMountMode(agent?: PipelineAgentId): 'rw' | 'ro' {
  switch (agent) {
    case 'B':
      return 'ro';
    case 'A':
    case 'C':
    case 'D':
    case 'S':
    default:
      return 'rw';
  }
}

export function getNetworkProfile(agent?: PipelineAgentId): 'research' | 'build' | 'none' {
  switch (agent) {
    case 'A':
    case 'B':
      return 'research';
    case 'C':
    case 'D':
      return 'build';
    default:
      return 'none';
  }
}

const PERMISSION_MODE = process.env.PIPELINE_PERMISSION_MODE || 'auto';

function permissionArgs(): string[] {
  if (PERMISSION_MODE === 'dangerously-skip-permissions') {
    return ['--dangerously-skip-permissions'];
  }
  return ['--permission-mode', PERMISSION_MODE];
}

export function buildClaudeArgs(opts: RunnerOptions): string[] {
  if (!hasValue(opts.roleFile) && !hasValue(opts.systemPrompt)) {
    throw new Error('RunnerOptions requires either roleFile or systemPrompt');
  }

  const args: string[] = [
    '-p', opts.prompt,
    ...permissionArgs(),
    '--model', opts.model,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (hasValue(opts.roleFile)) {
    args.push('--system-prompt-file', opts.roleFile);
  } else if (hasValue(opts.systemPrompt)) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (hasValue(opts.effort)) {
    args.push('--effort', opts.effort);
  }

  if (hasValue(opts.resume)) {
    args.push('--resume', opts.resume);
  }

  if (opts.jsonSchema) {
    args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  }

  return args;
}

function buildContainerClaudeArgs(opts: RunnerOptions): string[] {
  const args: string[] = [
    '-p', opts.prompt,
    ...permissionArgs(),
    '--model', opts.model,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (hasValue(opts.roleFile)) {
    args.push('--system-prompt-file', '/opt/pipeline/role.md');
  } else if (hasValue(opts.systemPrompt)) {
    args.push('--system-prompt', opts.systemPrompt);
  } else {
    throw new Error('RunnerOptions requires either roleFile or systemPrompt');
  }

  if (hasValue(opts.effort)) {
    args.push('--effort', opts.effort);
  }

  if (hasValue(opts.resume)) {
    args.push('--resume', opts.resume);
  }

  if (opts.jsonSchema) {
    args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  }

  return args;
}

export function buildRunnerEnv(opts: RunnerOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.extraEnv,
    // Reset Claude's working directory after each Bash command so a `cd`
    // does not persist into later Write/Edit tool calls.
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
  };

  if (hasValue(opts.pipelineAgent)) {
    env.PIPELINE_AGENT = opts.pipelineAgent;
  }

  if (hasValue(opts.securityMode)) {
    env.PIPELINE_SECURITY_MODE = opts.securityMode;
  }

  if (opts.pipelineAgent === 'C' || opts.pipelineAgent === 'D') {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }

  return env;
}

export function isRecoverableDockerAuthFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    'not logged in',
    'please run /login',
    'invalid bearer token',
    'authentication_failed',
    '"type":"authentication_error"',
    'failed to authenticate. api error: 401',
  ].some((needle) => normalized.includes(needle));
}

function withBackend(child: RunnerChild, backend: RunnerBackend): SpawnedRunnerChild {
  return Object.assign(child, { backend });
}

export function buildDockerArgs(
  opts: RunnerOptions,
  authBootstrap: DockerCredentialBootstrap,
): string[] {
  const hostAuthEnv = {
    ...process.env,
    ...opts.extraEnv,
  };
  const agentLabel = opts.pipelineAgent || 'session';
  const containerProject = `/home/node/Builds/${basename(opts.projectDir)}`;
  const containerName = `devsquad-${projectHash(opts.projectDir)}-${agentLabel}-${Date.now()}`;
  const sessionVolume = `devsquad-sessions-${projectHash(opts.projectDir)}-${agentLabel}`;
  const projectAccess = getProjectMountMode(opts.pipelineAgent);
  const dockerArgs: string[] = [
    'run', '--rm',
    '--name', containerName,
    '-v', `${opts.projectDir}:${containerProject}:${projectAccess}`,
    '-v', `${sessionVolume}:/home/node/.claude`,
    '--memory', '4g',
    '--cpus', '2',
    '-w', containerProject,
  ];

  if (hasValue(opts.pipelineDir) && existsSync(`${opts.pipelineDir}/.claude/hooks`)) {
    dockerArgs.push('-v', `${opts.pipelineDir}/.claude/hooks:${containerProject}/.claude/hooks:ro`);
  }

  if (hasValue(opts.pipelineDir) && existsSync(`${opts.pipelineDir}/.claude/settings.json`)) {
    dockerArgs.push('-v', `${opts.pipelineDir}/.claude/settings.json:${containerProject}/.claude/settings.json:ro`);
  }

  if (hasValue(opts.roleFile)) {
    dockerArgs.push('-v', `${opts.roleFile}:/opt/pipeline/role.md:ro`);
  }

  for (const file of opts.templateFiles || []) {
    if (!existsSync(file)) continue;
    dockerArgs.push('-v', `${file}:/opt/pipeline/${basename(file)}:ro`);
  }

  dockerArgs.push(...authBootstrap.mountArgs);

  dockerArgs.push('--cap-add=NET_ADMIN', '--cap-add=NET_RAW');
  for (const envKey of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const) {
    if (hasValue(hostAuthEnv[envKey])) {
      dockerArgs.push('-e', envKey);
    }
  }
  dockerArgs.push('-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');

  if (hasValue(opts.pipelineAgent)) {
    dockerArgs.push('-e', `PIPELINE_AGENT=${opts.pipelineAgent}`);
  }

  if (hasValue(opts.securityMode)) {
    dockerArgs.push('-e', `PIPELINE_SECURITY_MODE=${opts.securityMode}`);
  }

  dockerArgs.push('-e', 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1');
  dockerArgs.push('-e', `AGENT_NETWORK_PROFILE=${getNetworkProfile(opts.pipelineAgent)}`);

  dockerArgs.push(
    DOCKER_IMAGE,
    '/usr/local/share/npm-global/bin/claude',
    ...buildContainerClaudeArgs(opts),
  );

  return dockerArgs;
}

export class HostRunner implements Runner {
  spawn(opts: RunnerOptions): SpawnedRunnerChild {
    return withBackend(nodeSpawn('claude', buildClaudeArgs(opts), {
      cwd: opts.projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildRunnerEnv(opts),
    }), 'host');
  }

  async cleanup(_projectDir: string): Promise<void> {
    void _projectDir;
  }

  isAvailable(): boolean {
    return true;
  }

  supportsHostFallback(opts: RunnerOptions): boolean {
    void opts;
    return false;
  }
}

export class DockerRunner implements Runner {
  spawn(opts: RunnerOptions): SpawnedRunnerChild {
    const workspace = prepareDockerWorkspace(opts);
    const authBootstrap = resolveDockerCredentialBootstrap();
    const dockerOpts = {
      ...opts,
      projectDir: workspace.mountedProjectDir,
    };
    const child = nodeSpawn('docker', buildDockerArgs(dockerOpts, authBootstrap), {
      cwd: workspace.mountedProjectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildRunnerEnv(opts),
    });

    let cleanedUp = false;
    const cleanupBootstrap = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      workspace.syncBack();
      workspace.cleanup();
      authBootstrap.cleanup();
    };

    child.on('close', cleanupBootstrap);
    child.on('error', cleanupBootstrap);

    return withBackend(child, 'docker');
  }

  async cleanup(projectDir: string): Promise<void> {
    const pid = projectHash(projectDir);
    const agents: Array<PipelineAgentId | 'session'> = ['A', 'B', 'C', 'D', 'S', 'session'];
    for (const agent of agents) {
      try {
        execFileSync('docker', ['volume', 'rm', '-f', `devsquad-sessions-${pid}-${agent}`], { stdio: 'pipe' });
      } catch {
        // Ignore missing volumes.
      }
      rmSync(getDockerWorkspaceDir(projectDir, agent === 'session' ? undefined : agent), {
        recursive: true,
        force: true,
      });
    }
  }

  isAvailable(): boolean {
    try {
      execFileSync('docker', ['info'], { stdio: 'pipe' });
      execFileSync('docker', ['image', 'inspect', DOCKER_IMAGE], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  supportsHostFallback(opts: RunnerOptions): boolean {
    void opts;
    return false;
  }

  unavailableReason(): string {
    try {
      execFileSync('docker', ['info'], { stdio: 'pipe' });
    } catch {
      return 'Docker is not running or not installed.';
    }

    try {
      execFileSync('docker', ['image', 'inspect', DOCKER_IMAGE], { stdio: 'pipe' });
    } catch {
      return `Docker image '${DOCKER_IMAGE}' not found. Build it with: docker build -t ${DOCKER_IMAGE} -f pipeline/Dockerfile.agent pipeline/`;
    }

    return '';
  }
}

export class AutoRunner implements Runner {
  private readonly host = new HostRunner();
  private readonly docker = new DockerRunner();
  private warned = false;

  spawn(opts: RunnerOptions): SpawnedRunnerChild {
    if (opts.forceHost) {
      return this.host.spawn(opts);
    }

    if (shouldPreferDocker(opts)) {
      if (this.docker.isAvailable()) {
        return this.docker.spawn(opts);
      }
      this.warnUnavailable();
    }

    return this.host.spawn(opts);
  }

  async cleanup(projectDir: string): Promise<void> {
    if (this.docker.isAvailable()) {
      await this.docker.cleanup(projectDir);
    }
  }

  isAvailable(): boolean {
    return true;
  }

  supportsHostFallback(opts: RunnerOptions): boolean {
    return shouldPreferDocker(opts) && !opts.forceHost;
  }

  private warnUnavailable() {
    if (this.warned) return;
    const reason = this.docker.unavailableReason();
    console.warn(`\x1b[33m[WARNING] ${reason}\x1b[0m`);
    console.warn('\x1b[33m[WARNING] Falling back to host runner for sandbox-eligible agents.\x1b[0m');
    this.warned = true;
  }
}

export function createRunner(mode: RunnerMode | string = process.env.PIPELINE_RUNNER || 'auto'): Runner {
  const requested = String(mode).toLowerCase() as RunnerMode;

  if (requested === 'host') {
    return new HostRunner();
  }

  if (requested === 'docker') {
    const docker = new DockerRunner();
    if (!docker.isAvailable()) {
      throw new Error(docker.unavailableReason());
    }
    return docker;
  }

  return new AutoRunner();
}
