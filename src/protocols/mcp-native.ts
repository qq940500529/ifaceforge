import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, posix, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AppError, failure, invalid } from '../app/errors.js';
import { digest, projectFile, protectedSource, stableJson } from '../app/files.js';
import { commitSource } from '../app/git-history.js';
import { gitAsync, type ProjectPaths } from '../app/project.js';
import { McpSession, needsFreshLegacyProcess } from './mcp.js';
import { ManagedMcpStdio, startMcpProcess, stopMcpProcess } from './mcp-process.js';
import { sandboxLaunchIssues, type SandboxCleanup, type SandboxReport } from './mcp-sandbox.js';
import { Bindings, type Profile } from './variables.js';

export interface NativePlan {
  mode: 'native';
  commit: string;
  source: 'git' | 'worktree';
  sourceHash: string;
  command: string;
  projectCommand?: string;
  args: string[];
  cwd: string;
  directory: string;
  environment: string[];
  optionalEnvironment?: string[];
  transport: 'stdio' | 'streamableHttp' | 'sse';
  url?: string;
  protocol?: string;
  issues: { code: 'missing-entry' | 'missing-directory' | 'native-platform'; path: string }[];
  fingerprint: string;
}

const hostEnv = ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHext', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL'];
const archiveExclude = [
  '**/.env',
  '**/.env.*',
  '**/.devtools/**',
  '**/.ipc-token',
  '**/*.pem',
  '**/*.key',
  '**/*.pfx',
  '**/*.p12',
];
const exec = promisify(execFile);

async function locateCommand(command: string) {
  const names =
    process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(command) ? [command + '.exe', command] : [command];
  const directories = isAbsolute(command) ? [''] : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  for (const directory of directories) {
    for (const name of names) {
      try {
        const target = await realpath(directory ? join(directory, name) : name);
        if (!(await stat(target)).isFile() || /\.(?:cmd|bat|ps1)$/i.test(target)) continue;
        await access(target, constants.X_OK);
        return target;
      } catch {
        // Continue looking in the approved host search path.
      }
    }
  }
}

export async function worktreeHash(root: string, commit: string) {
  const changes = await gitAsync(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths: string[] = [];
  const entries = changes.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index++) {
    const status = entries[index].slice(0, 2);
    paths.push(entries[index].slice(3));
    if (/[RC]/.test(status)) paths.push(entries[++index]);
  }
  const files: [string, string | null][] = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!path || protectedSource.test(path)) continue;
    try {
      const file = projectFile(root, path);
      const info = await lstat(file);
      if (info.isFile() && info.size <= 32 * 1024 * 1024) files.push([path, digest(await readFile(file))]);
      else files.push([path, String(info.size) + ':' + String(info.mtimeMs)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files.push([path, null]);
    }
  }
  return digest(stableJson({ commit, changes, files }));
}

export function localMcpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid('Expected a valid local MCP URL');
  }
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    invalid('A temporary MCP HTTP entry must specify an explicit HTTP loopback port and path');
  url.hostname = '127.0.0.1';
  return url;
}

export async function prepareNative(
  project: ProjectPaths,
  profile: Profile,
  commit: string,
  historical: boolean,
  configPath?: string,
  optionalEnvironment: string[] = [],
): Promise<NativePlan> {
  const config = profile.mcp;
  if (!config?.command) invalid('Select a repository MCP service with a launch command');
  const cwd = posix.normalize((config.cwd ?? '.').replaceAll('\\', '/')).replace(/\/$/, '') || '/';
  if (cwd === '..' || cwd.startsWith('../') || cwd.startsWith('/') || /^[a-z]:/i.test(cwd) || cwd.includes('\0'))
    invalid('MCP working directory must be inside the selected source');
  const bindings = new Bindings(profile);
  const args = (config.args ?? []).map((argument) => String(bindings.resolve(argument)));
  if (!config.command.trim() || /[\x00-\x1f]/.test(config.command) || args.some((arg) => arg.includes('\0')))
    invalid('Invalid MCP launch command');
  if (bindings.secrets.size) invalid('Use explicit environment bindings for secrets instead of command arguments');
  const source = historical ? commitSource(project.root, commit) : undefined;
  const tree = source ?? {
    commit,
    paths: (await gitAsync(project.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
      .split('\0')
      .filter(Boolean),
    has(path: string) {
      try {
        projectFile(project.root, path);
        return true;
      } catch {
        return false;
      }
    },
    read() {
      throw Error('Unexpected source read');
    },
  };
  const launch = sandboxLaunchIssues(config.command, args, cwd, tree, configPath);
  const issues: NativePlan['issues'] = launch.issues.flatMap((issue) =>
    issue.code === 'missing-entry' || issue.code === 'missing-directory'
      ? [{ code: issue.code, path: issue.path }]
      : [],
  );
  const selected = config.command.replaceAll('\\', '/');
  const local = !isAbsolute(config.command) && selected.includes('/');
  const projectCommand = local ? posix.join(launch.cwd, selected) : undefined;
  if (projectCommand && (projectCommand.startsWith('../') || protectedSource.test(projectCommand)))
    invalid('MCP executable escapes the selected source');
  const executable = local ? projectCommand : await locateCommand(config.command);
  if (local ? !executable || !tree.has(executable) : !executable)
    issues.push({ code: 'missing-entry', path: config.command });
  if (process.platform !== 'win32' && launch.issues.some((issue) => issue.code === 'windows-launcher'))
    issues.push({ code: 'native-platform', path: config.command });
  if (/\.(?:cmd|bat|ps1)$/i.test(config.command)) issues.push({ code: 'native-platform', path: config.command });
  const url = config.transport === 'stdio' ? undefined : localMcpUrl(String(bindings.resolve(config.url))).href;
  if (bindings.secrets.size) invalid('Use HTTP header bindings for secrets instead of endpoint URLs');
  const plan = {
    mode: 'native' as const,
    commit,
    source: historical ? ('git' as const) : ('worktree' as const),
    sourceHash: historical ? commit : await worktreeHash(project.root, commit),
    command: executable ?? config.command,
    projectCommand,
    args,
    cwd: launch.cwd,
    directory: historical ? posix.join('<temporary>', launch.cwd) : projectFile(project.root, launch.cwd, false),
    environment: [...new Set([...hostEnv, ...Object.keys(config.env ?? {})])].sort(),
    optionalEnvironment,
    transport: config.transport,
    url,
    protocol: config.protocolVersion,
    issues,
  };
  const file = !local && executable ? await stat(executable) : undefined;
  const environment = Object.fromEntries(hostEnv.map((key) => [key, process.env[key]]));
  return {
    ...plan,
    fingerprint: digest(
      stableJson({
        project: project.root,
        plan,
        profile,
        environment,
        executable: file && [file.size, file.mtimeMs],
      }),
    ),
  };
}

function available(port: number) {
  const server = createServer();
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve()));
  });
}

function listening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function openNative(
  project: ProjectPaths,
  profile: Profile,
  plan: NativePlan,
  bindings: Bindings,
  parent: AbortSignal,
  onFailed: (report: SandboxReport) => void,
  progress?: (stage: 'launch' | 'ready' | 'negotiate') => void,
) {
  const config = profile.mcp!;
  const signal = AbortSignal.any([parent, AbortSignal.timeout(45_000)]);
  const instance = 'ifaceforge-native-' + randomUUID();
  let stage: 'prepare' | 'launch' | 'ready' | 'negotiate' = 'prepare';
  let temporary: string | undefined;
  let session: McpSession | undefined;
  let transport: ManagedMcpStdio | undefined;
  let child: ReturnType<typeof startMcpProcess> | undefined;
  let startupError: Error | undefined;
  let output = Buffer.alloc(0);
  let port: number | undefined;
  let ownsPort = false;
  let closing: Promise<SandboxCleanup> | undefined;
  const capture = (chunk: Buffer) => {
    output = Buffer.concat([output, chunk]).subarray(-16 * 1024);
  };
  const close = () =>
    (closing ??= (async (): Promise<SandboxCleanup> => {
      try {
        await session?.close().catch(() => undefined);
        if (transport) await transport.close();
        if (child) await stopMcpProcess(child);
        if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
        if (port && ownsPort && (await listening(port)))
          return { state: 'failed', message: 'The loopback port is still in use: ' + port };
        return { state: 'removed' };
      } catch (error) {
        return { state: 'failed', message: bindings.redact((error as Error).message) };
      }
    })());

  try {
    let root = project.root;
    if (plan.source === 'git') {
      temporary = await mkdtemp(join(tmpdir(), 'ifaceforge-mcp-native-'));
      const archive = join(temporary, 'source.tar');
      await gitAsync(
        root,
        [
          'archive',
          '--format=tar',
          '--prefix=source/',
          '--output=' + archive,
          plan.commit,
          '--',
          ...archiveExclude.map((path) => ':(exclude,glob,icase)' + path),
        ],
        signal,
      );
      if ((await stat(archive)).size > 256 * 1024 * 1024) invalid('The committed MCP workspace exceeds 256 MiB');
      const tar = await locateCommand('tar');
      if (!tar) invalid('Install tar to run MCP from a historical commit');
      await exec(tar, ['-xf', archive, '-C', temporary], { windowsHide: true, signal });
      root = resolve(temporary, 'source');
    } else if (plan.sourceHash !== (await worktreeHash(root, plan.commit))) {
      throw new AppError('MCP_PLAN_CHANGED', 'The working tree changed after review');
    }
    signal.throwIfAborted();
    const env: Record<string, string> = {};
    for (const key of hostEnv) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    for (const [name, ref] of Object.entries(config.env ?? {})) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(name) || /^IFG_MCP_/i.test(name))
        invalid('Invalid MCP environment binding', { name });
      env[name] = bindings.environment(ref.env);
    }
    for (const name of plan.optionalEnvironment ?? []) {
      if (Object.hasOwn(env, name)) continue;
      try {
        env[name] = bindings.environment(name);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'MISSING_VARIABLE') throw error;
      }
    }
    const command = plan.projectCommand ? projectFile(root, plan.projectCommand) : plan.command;
    const cwd = projectFile(root, plan.cwd);
    const parsed = plan.url ? new URL(plan.url) : undefined;
    if (parsed) {
      port = Number(parsed.port);
      await available(port).catch(() => {
        throw new AppError('MCP_PORT_IN_USE', 'The requested MCP loopback port is already in use', 3, { port });
      });
    }
    stage = 'launch';
    progress?.(stage);
    if (config.transport === 'stdio') {
      const start = () => new ManagedMcpStdio(() => startMcpProcess(command, plan.args, cwd, env), capture);
      transport = start();
      stage = 'negotiate';
      progress?.(stage);
      try {
        session = await McpSession.connect(profile, root, bindings, signal, { transport });
      } catch (error) {
        if (
          config.protocolVersion ||
          signal.aborted ||
          !needsFreshLegacyProcess(error) ||
          output.length ||
          transport.exitCode !== 0
        )
          throw error;
        await transport.close();
        transport = start();
        session = await McpSession.connect(profile, root, bindings, signal, { transport, legacy: true });
      }
    } else {
      child = startMcpProcess(command, plan.args, cwd, env);
      child.on('error', (error) => {
        startupError = error;
      });
      child.stdin.on('error', () => undefined);
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      stage = 'ready';
      progress?.(stage);
      while (!(await listening(port!))) {
        signal.throwIfAborted();
        if (startupError) throw startupError;
        if (child.exitCode !== null) throw Error('MCP server exited before readiness');
        await delay(150, undefined, { signal });
      }
      ownsPort = true;
      stage = 'negotiate';
      progress?.(stage);
      session = await McpSession.connect(
        { ...profile, mcp: { ...config, url: parsed!.href } },
        root,
        bindings,
        signal,
        {
          fetch(input, init) {
            const url = new URL(input instanceof Request ? input.url : input);
            if (url.origin !== parsed!.origin)
              throw new AppError('MCP_ENDPOINT_OUTSIDE', 'MCP request left the reviewed loopback endpoint');
            return fetch(input, { ...init, redirect: 'error' });
          },
        },
      );
    }
    return { session, instance, close };
  } catch (error) {
    const cleanup = await close();
    onFailed({
      commit: plan.commit,
      mode: 'native',
      codeSource: plan.source,
      sourceHash: plan.sourceHash,
      instance,
      cleanup,
    });
    if (parent.aborted) throw parent.reason;
    const cause = failure(error);
    throw new AppError(
      'MCP_NATIVE_FAILED',
      'The local MCP process did not complete startup',
      3,
      bindings.redact({
        stage,
        instance,
        cleanup,
        executable: basename(plan.command),
        cause: { code: cause.code, message: cause.message, details: cause.details },
        exitCode: child?.exitCode ?? transport?.exitCode ?? undefined,
        startupOutput: output.toString().slice(-8192) || undefined,
      }),
    );
  }
}
