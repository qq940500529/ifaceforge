import { execFile, spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, posix, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AppError, failure, invalid } from '../app/errors.js';
import { digest, stableJson, type ScanSource } from '../app/files.js';
import { gitAsync, type ProjectPaths } from '../app/project.js';
import { commitSource, resolveCommit } from '../app/git-history.js';
import { McpSession, needsFreshLegacyProcess } from './mcp.js';
import { relayFetch } from './mcp-relay.js';
import { Bindings, type Profile } from './variables.js';

const docker = promisify(execFile);
const maxArchive = 256 * 1024 * 1024;
const launchTimeout = 60_000;
const excluded = [
  '**/.env',
  '**/.env.*',
  '**/.devtools/**',
  '**/.ipc-token',
  '**/*.pem',
  '**/*.key',
  '**/*.pfx',
  '**/*.p12',
];

export interface SandboxPlan {
  commit: string;
  image: string;
  imageId: string;
  dockerPath: string;
  context: string;
  command: string;
  args: string[];
  cwd: string;
  directory: string;
  transport: 'stdio' | 'streamableHttp' | 'sse';
  protocol?: string;
  url?: string;
  environment: string[];
  issues: { code: 'windows-launcher' | 'missing-directory' | 'missing-entry' | 'image-os'; path: string }[];
  fingerprint: string;
}

export type SandboxCleanup = { state: 'removed' | 'failed'; message?: string };
export type SandboxReport = {
  commit: string;
  imageId?: string;
  mode?: 'isolated' | 'native';
  backend?: 'docker';
  codeSource?: 'git' | 'worktree';
  sourceHash?: string;
  instance: string;
  cleanup: SandboxCleanup;
};

export function windowsLauncher(command: string) {
  return /^(?:[a-z]:[\\/]|\\\\)|\.(?:exe|cmd|bat)$/i.test(command) || /^(?:powershell|cmd)$/i.test(command);
}

function launchFiles(command: string, args: string[]) {
  const normalized = command.replaceAll('\\', '/');
  const interpreter = posix.basename(normalized).toLowerCase();
  const fileOption = args.findIndex((arg) => /^-file$/i.test(arg));
  const script =
    fileOption >= 0
      ? args[fileOption + 1]
      : /^(?:node|deno|bun|python[\d.]*|pypy[\d.]*|pwsh|bash|sh|ruby|perl)$/.test(interpreter)
        ? args.find((arg) => !/^(?:-u|-B|--unbuffered|--no-warnings)$/.test(arg))
        : undefined;
  const entry =
    normalized.includes('/') && !posix.isAbsolute(normalized) && !windowsLauncher(normalized)
      ? normalized
      : undefined;
  return [entry, script && /^[^-].*\.(?:ps1|[cm]?js|[cm]?ts|py|sh|rb|pl)$/i.test(script) ? script : undefined]
    .filter((item): item is string => Boolean(item))
    .map((item) => item.replaceAll('\\', '/'))
    .filter((item) => !posix.isAbsolute(item) && !/^[a-z]:/i.test(item));
}

export function sandboxLaunchIssues(
  command: string,
  args: string[],
  cwd: string,
  source: ScanSource,
  configPath?: string,
) {
  const issues: SandboxPlan['issues'] = [];
  if (windowsLauncher(command)) issues.push({ code: 'windows-launcher', path: command });
  const files = launchFiles(command, args);
  const has = (directory: string, file: string) => source.has(posix.join(directory, file));
  if (cwd === '.' && configPath && files.length && !files.every((file) => has(cwd, file))) {
    const configured = posix.dirname(configPath);
    if (files.every((file) => has(configured, file))) cwd = configured;
  }
  if (cwd !== '.' && ![...source.paths].some((path) => path.startsWith(cwd + '/')))
    issues.push({ code: 'missing-directory', path: cwd });
  for (const file of files) {
    const path = posix.join(cwd, file);
    if (!has(cwd, file)) issues.push({ code: 'missing-entry', path });
  }
  return { cwd, directory: posix.join('/workspace', cwd), issues };
}

export function assertSandboxLaunch(plan: SandboxPlan) {
  if (plan.issues.length)
    throw new AppError(
      'MCP_SANDBOX_INCOMPATIBLE',
      'The reviewed command cannot run in the selected container',
      2,
      {
        issues: plan.issues,
        directory: plan.directory,
        image: plan.image,
        commit: plan.commit,
      },
    );
}

function dockerError(error: unknown) {
  if ((error as { code?: string }).code === 'ENOENT')
    throw new AppError('MCP_SANDBOX_UNAVAILABLE', 'Install Docker and enable its local Linux container engine');
  throw new AppError('MCP_SANDBOX_UNAVAILABLE', 'The local Docker Linux container engine is unavailable');
}

async function dockerExecutable(root: string) {
  const name = process.platform === 'win32' ? 'docker.exe' : 'docker';
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const executable = await realpath(join(directory, name));
      const fromProject = relative(root, executable);
      if (!isAbsolute(fromProject) && fromProject !== '..' && !fromProject.startsWith('..' + sep)) continue;
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch {
      // Continue searching the configured executable directories.
    }
  }
  throw new AppError(
    'MCP_SANDBOX_UNAVAILABLE',
    'Install Docker on PATH outside the project and start its Linux engine',
  );
}

export async function prepareSandbox(
  project: ProjectPaths,
  profile: Profile,
  ref?: string,
  imageOverride?: string,
  repositorySource?: { path: string; source: ScanSource },
) {
  const config = profile.mcp;
  if (!config?.command) invalid('Select an MCP service with a repository launch command');
  const cwd = posix.normalize((config.cwd ?? '.').replaceAll('\\', '/')).replace(/\/$/, '') || '/';
  if (cwd === '..' || cwd.startsWith('../') || cwd.startsWith('/') || /^[A-Za-z]:/.test(cwd) || cwd.includes('\0'))
    invalid('MCP working directory must be inside the Git snapshot');
  const bindings = new Bindings(profile);
  const args = config.args?.map((argument) => String(bindings.resolve(argument))) ?? [];
  if (!config.command.trim() || /[\x00-\x1f]/.test(config.command) || args.some((arg) => arg.includes('\0')))
    invalid('Invalid MCP launch command');
  let url: string | undefined;
  if (config.transport !== 'stdio') {
    const target = new URL(String(bindings.resolve(config.url)));
    if (
      target.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(target.hostname) ||
      target.username ||
      target.password
    )
      invalid('MCP HTTP must use an explicit loopback URL inside the container');
    url = target.href;
  }
  const image = imageOverride ?? config.image ?? 'node:26-alpine';
  if (!/^[\w][\w./:@-]{0,240}$/.test(image)) invalid('Invalid Docker image reference');
  const dockerPath = await dockerExecutable(project.root);
  const commandOptions = { windowsHide: true, timeout: 20_000 };
  let context: string;
  try {
    context = (await docker(dockerPath, ['context', 'show'], commandOptions)).stdout.trim();
    if (!/^[\w][\w.-]*$/.test(context)) invalid('Invalid Docker context');
    const endpoint = (
      await docker(
        dockerPath,
        ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'],
        commandOptions,
      )
    ).stdout.trim();
    if (!/^(?:unix:\/\/\/|npipe:\/\/\/\/\.\/pipe\/)/i.test(endpoint))
      throw new AppError('MCP_SANDBOX_UNAVAILABLE', 'Select a Docker context backed by a local socket');
    const os = (
      await docker(dockerPath, ['--context', context, 'version', '--format', '{{.Server.Os}}'], commandOptions)
    ).stdout.trim();
    if (os !== 'linux')
      throw new AppError('MCP_SANDBOX_UNAVAILABLE', 'The selected Docker context needs Linux containers');
  } catch (error) {
    if (error instanceof AppError) throw error;
    dockerError(error);
  }
  let imageId: string, imageOs: string;
  try {
    [imageId, imageOs] = (
      await docker(
        dockerPath,
        ['--context', context!, 'image', 'inspect', '--format', '{{.Id}} {{.Os}}', image],
        commandOptions,
      )
    ).stdout
      .trim()
      .split(/\s+/);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Invalid image ID');
  } catch {
    throw new AppError(
      'MCP_SANDBOX_IMAGE',
      'Prepare the selected Docker image locally before starting the service',
      3,
      { image },
    );
  }
  const commit = repositorySource?.source.commit ?? (await resolveCommit(project.root, ref ?? 'HEAD'));
  const launch = sandboxLaunchIssues(
    config.command,
    args,
    cwd,
    repositorySource?.source ?? commitSource(project.root, commit),
    repositorySource?.path,
  );
  if (imageOs !== 'linux') launch.issues.push({ code: 'image-os', path: imageOs });
  const plan: Omit<SandboxPlan, 'fingerprint'> = {
    commit,
    image,
    imageId,
    dockerPath,
    context: context!,
    command: config.command,
    args: bindings.redact(args),
    cwd: launch.cwd,
    directory: launch.directory,
    issues: launch.issues.map((issue) => ({ ...issue, path: bindings.redact(issue.path) })),
    transport: config.transport,
    protocol: config.protocolVersion,
    url: url && bindings.redact(url),
    environment: Object.keys(config.env ?? {}).sort(),
  };
  const fingerprint = digest(stableJson({ plan, root: project.root, profile }));
  return { ...plan, fingerprint };
}

const httpRelay = String.raw`
import { Readable } from 'node:stream';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { url, method, headers, body } = JSON.parse(input);
const response = await fetch(url, { method, headers, body, redirect: 'error' });
process.stdout.write(JSON.stringify({ status: response.status, headers: [...response.headers] }) + '\n');
if (response.body) Readable.fromWeb(response.body).pipe(process.stdout);
`;

function sandboxFetch(dockerPath: string, args: string[], origin: string): typeof fetch {
  return relayFetch(origin, (signal) =>
    spawn(dockerPath, [...args, 'node', '--input-type=module', '-e', httpRelay], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      signal,
    }),
  );
}

export async function openSandbox(
  project: ProjectPaths,
  profile: Profile,
  plan: SandboxPlan,
  bindings: Bindings,
  parent: AbortSignal,
  onFailed: (report: SandboxReport) => void,
  progress?: (stage: 'launch' | 'ready' | 'negotiate') => void,
) {
  assertSandboxLaunch(plan);
  const config = profile.mcp!;
  const signal = AbortSignal.any([parent, AbortSignal.timeout(launchTimeout)]);
  const temporary = await mkdtemp(join(tmpdir(), 'ifaceforge-mcp-'));
  const instance = 'ifaceforge-mcp-' + randomUUID();
  const staging = instance + '-stage';
  const volume = instance + '-workspace';
  const engine = ['--context', plan.context];
  const { dockerPath } = plan;
  const options = { windowsHide: true, timeout: 30_000 };
  let attempted = false;
  let stage = 'archive';
  let attached = Buffer.alloc(0);
  let session: McpSession | undefined;
  async function remove(args: string[]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await docker(dockerPath, [...engine, ...args], options);
        return true;
      } catch (error) {
        if (/No such (?:container|volume)/i.test(String((error as { stderr?: unknown }).stderr))) return true;
        if (attempt < 2) await delay(250);
      }
    }
    return false;
  }
  async function close(): Promise<SandboxCleanup> {
    if (session) await session.close().catch(() => undefined);
    if (!attempted) return { state: 'removed' };
    const removed = await Promise.all([remove(['rm', '-f', '-v', instance]), remove(['rm', '-f', '-v', staging])]);
    const removedVolume = await remove(['volume', 'rm', volume]);
    if (removed.every(Boolean) && removedVolume) return { state: 'removed' };
    return { state: 'failed', message: 'Could not verify removal of ' + instance };
  }
  async function commandsOnFailure(waitForExit = false): Promise<{
    exitCode?: number;
    dockerError?: string;
    startupOutput?: string;
  }> {
    if (stage !== 'start' && stage !== 'handshake') return {};
    const diagnostics = { ...options, timeout: 7000, maxBuffer: 64 * 1024 };
    const [inspect, logs] = await Promise.all([
      docker(dockerPath, [...engine, 'inspect', '--format', '{{json .State}}', instance], diagnostics).catch(
        () => undefined,
      ),
      docker(dockerPath, [...engine, 'logs', '--tail', '24', instance], diagnostics).catch(() => undefined),
    ]);
    let state: { Status?: string; Error?: string; ExitCode?: number } = {};
    try {
      state = JSON.parse(inspect?.stdout ?? '{}');
    } catch {
      /* The container may already have exited. */
    }
    let exitCode = state.Status === 'exited' || state.Error ? state.ExitCode : undefined;
    if (exitCode === undefined && waitForExit) {
      const waited = await docker(dockerPath, [...engine, 'wait', instance], diagnostics).catch(() => undefined);
      const result = waited?.stdout.trim();
      if (result && /^\d+$/.test(result)) exitCode = Number(result);
    }
    return {
      exitCode,
      dockerError: state.Error || undefined,
      startupOutput: attached.toString() || logs?.stderr || undefined,
    };
  }
  try {
    const archive = join(temporary, 'workspace.tar');
    await gitAsync(
      project.root,
      [
        'archive',
        '--format=tar',
        '--prefix=workspace/',
        '--output=' + archive,
        plan.commit,
        '--',
        ...excluded.map((path) => `:(exclude,glob,icase)${path}`),
      ],
      signal,
    );
    if ((await stat(archive)).size > maxArchive) invalid('The committed MCP workspace exceeds 256 MiB');
    stage = 'environment';
    const values = Object.entries(config.env ?? {}).map(([name, ref]) => {
      const value = bindings.environment(ref.env);
      if (!/^[a-z_][a-z0-9_]*$/i.test(name) || /[\r\n\0]/.test(value))
        invalid('Invalid sandbox environment binding', { name });
      return `${name}=${value}`;
    });
    const envFile = join(temporary, 'environment');
    if (values.length) await writeFile(envFile, values.join('\n') + '\n', { mode: 0o600 });
    attempted = true;
    stage = 'workspace';
    await docker(
      dockerPath,
      [...engine, 'volume', 'create', '--label', 'com.shulianchuangyuan.ifaceforge.mcp=1', volume],
      { ...options, signal },
    );
    const mount = 'type=volume,source=' + volume + ',target=/workspace,volume-nocopy';
    const seed = docker(
      dockerPath,
      [
        ...engine,
        'run',
        '--rm',
        '--interactive',
        '--name',
        staging,
        '--network',
        'none',
        '--read-only',
        '--no-healthcheck',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--memory',
        '512m',
        '--pids-limit',
        '32',
        '--cpus',
        '1',
        '--user',
        '0:0',
        '--pull',
        'never',
        '--mount',
        mount,
        '--entrypoint',
        'tar',
        plan.imageId,
        '-xf',
        '-',
        '-C',
        '/workspace',
        '--strip-components=1',
        '--no-same-owner',
      ],
      { ...options, signal },
    );
    await Promise.all([pipeline(createReadStream(archive), seed.child.stdin!), seed]);
    stage = 'create';
    progress?.('launch');
    await docker(
      dockerPath,
      [
        ...engine,
        'create',
        '--name',
        instance,
        '--label',
        'com.shulianchuangyuan.ifaceforge.mcp=1',
        '--pull',
        'never',
        '--init',
        '--interactive',
        '--network',
        'none',
        '--read-only',
        '--no-healthcheck',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '128',
        '--memory',
        '512m',
        '--cpus',
        '1',
        '--user',
        '10001:10001',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
        '--env',
        'HOME=/tmp',
        ...(values.length ? ['--env-file', envFile] : []),
        '--workdir',
        plan.directory,
        '--entrypoint',
        plan.command,
        '--mount',
        mount + ',readonly',
        plan.imageId,
        ...(config.args ?? []).map((arg) => String(bindings.resolve(arg))),
      ],
      { ...options, signal },
    );
    if (config.transport === 'stdio') {
      stage = 'handshake';
      progress?.('negotiate');
      const boundary = {
        stdio: { command: dockerPath, args: [...engine, 'start', '--attach', '--interactive', instance] },
        onStderr(chunk: Buffer) {
          attached = Buffer.concat([attached, chunk]).subarray(-64 * 1024);
        },
      };
      try {
        session = await McpSession.connect(profile, project.root, bindings, signal, boundary);
      } catch (error) {
        if (config.protocolVersion || signal.aborted || !needsFreshLegacyProcess(error)) throw error;
        const output = await commandsOnFailure(true);
        if (output.dockerError || output.startupOutput || (output.exitCode !== undefined && output.exitCode !== 0))
          throw error;
        await docker(dockerPath, [...engine, 'stop', '--time', '1', instance], { ...options, signal });
        session = await McpSession.connect(profile, project.root, bindings, signal, { ...boundary, legacy: true });
      }
    } else {
      const url = new URL(String(bindings.resolve(config.url)));
      stage = 'start';
      progress?.('ready');
      await docker(dockerPath, [...engine, 'start', instance], { ...options, signal });
      stage = 'handshake';
      progress?.('negotiate');
      const fetch = sandboxFetch(dockerPath, [...engine, 'exec', '-i', instance], url.origin);
      for (let attempt = 0; ; attempt++) {
        try {
          session = await McpSession.connect(profile, project.root, bindings, signal, { fetch });
          break;
        } catch (error) {
          if (attempt >= 8 || signal.aborted) throw error;
          await delay(225, undefined, { signal });
        }
      }
    }
    return { session, close, instance };
  } catch (error) {
    const cause = failure(error);
    const disconnected =
      cause.code === 'MCP_CONNECT_FAILED' && (cause.details as { cause?: string })?.cause === 'MCP_DISCONNECTED';
    const startup = parent.aborted ? {} : await commandsOnFailure(disconnected);
    const cleanup = await close();
    if (attempted) onFailed({ commit: plan.commit, imageId: plan.imageId, instance, cleanup });
    if (!attempted && (error instanceof AppError || signal.aborted)) throw error;
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = bindings.redact({
      stage,
      instance,
      cleanup,
      cause: { code: cause.code, details: cause.details },
      commandError: stderr ? String(stderr) : undefined,
      ...startup,
    });
    for (const field of ['commandError', 'dockerError', 'startupOutput'] as const) {
      const value = detail[field];
      if (typeof value === 'string') detail[field] = value.slice(-8192);
    }
    if (parent.aborted && cleanup.state !== 'failed') throw parent.reason;
    if (cleanup.state === 'failed') throw new AppError('MCP_SANDBOX_CLEANUP', cleanup.message!, 3, detail);
    const exited = detail.exitCode !== undefined || Boolean(detail.dockerError);
    throw new AppError(
      stage === 'handshake' && !exited ? cause.code : 'MCP_SANDBOX_START',
      stage === 'handshake' && !exited ? cause.message : 'Could not start the isolated MCP service',
      cause.exitCode,
      detail,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
