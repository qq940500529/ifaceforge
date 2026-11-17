import { catalog, getEntity, getSnapshot } from './catalog.js';
import { AppError, invalid } from './errors.js';
import { digest, sourceText, stableJson } from './files.js';
import { commitSource, resolveCommit } from './git-history.js';
import type { ProjectPaths } from './project.js';
import { repositoryProfile, type Plan, type SandboxTarget, type SandboxTargets } from './runs.js';
import { assertSandboxLaunch, prepareSandbox, windowsLauncher } from '../protocols/mcp-sandbox.js';
import { prepareNative } from '../protocols/mcp-native.js';
import { mcpVersions } from '../protocols/mcp-versions.js';
import { secretHeader, type EnvRef, type Pair, type Profile } from '../protocols/variables.js';
import { mcpConfigDocument, parseMcpConfig } from '../scanner/adapters.js';
import type { Entity } from '../scanner/model.js';
import { mapping } from '../scanner/openapi.js';
import { validate } from '../schemas/index.js';
import type { Repository } from '../storage/repository.js';

const server = (entity: Entity) =>
  entity.observations.find((entry) => entry.definition.type === 'server' && entry.path);
const isRunnable = (template: Record<string, unknown>) =>
  typeof template.command === 'string' && !!template.command.trim();

function environmentReference(value: unknown) {
  if (typeof value === 'string') return /^\$\{(?:env:)?([a-z_][a-z0-9_]*)\}$/i.exec(value)?.[1];
  const ref = mapping(value).env;
  return typeof ref === 'string' ? ref : undefined;
}

function configuredHeaders(value: unknown, path: string) {
  if (value === undefined) return;
  const pairs = Array.isArray(value)
    ? value.map(mapping)
    : Object.entries(mapping(value)).map(([name, value]) => ({ name, value }));
  return pairs.map((entry) => {
    const { name, value } = entry;
    const reference = environmentReference(value);
    if (typeof name === 'string' && secretHeader.test(name) && !reference)
      invalid('Use an environment reference for a sensitive MCP HTTP header', { name, path });
    return { ...entry, value: reference ? { env: reference } : value } as Pair;
  });
}

export function mcpTargets(repository: Repository, snapshot?: string) {
  return catalog(repository, snapshot).flatMap((entity) => {
    const entry = server(entity);
    const template = mapping(entry?.definition.template);
    const launches = mapping(template.launch);
    const native = { ...template, ...mapping(launches.native) };
    const isolated = { ...template, ...mapping(launches.isolated) };
    const command = native.command ?? isolated.command;
    return entry && (isRunnable(native) || isRunnable(isolated))
      ? [
          {
            id: entity.id,
            name: entity.name,
            path: entry.path,
            transport: entry.definition.transport,
            windowsLauncher: typeof command === 'string' && windowsLauncher(command),
          },
        ]
      : [];
  });
}

export async function mcpTarget(
  project: ProjectPaths,
  repository: Repository,
  target: {
    profile?: string;
    service?: string;
    image?: string;
    ref?: string;
    snapshot?: string;
    mode?: string;
    protocol?: string;
  },
) {
  if (Boolean(target.profile) === Boolean(target.service))
    invalid('Select a repository MCP server or a local MCP profile');
  const mode = target.mode ?? 'isolated';
  if (mode !== 'native' && mode !== 'isolated') invalid('Unknown MCP launch mode', { mode });
  if (mode === 'native' && target.image) invalid('Choose an image only for isolated discovery');
  const pin = mcpVersions.find((version) => version === target.protocol);
  if (target.protocol && target.protocol !== 'auto' && !pin)
    invalid('Unsupported MCP protocol version', { supported: mcpVersions });
  let profile: Profile;
  let optionalEnvironment: string[] = [];
  let path: string | undefined;
  let repositorySource: Parameters<typeof prepareSandbox>[4];
  let service: string;
  const snapshot = target.snapshot ? getSnapshot(repository, target.snapshot) : undefined;
  const historical = Boolean(target.ref || snapshot?.source === 'git');
  const commit = await resolveCommit(
    project.root,
    target.ref ?? ((snapshot?.source === 'git' && snapshot.commit) || 'HEAD'),
  );
  if (target.profile) {
    profile = repository.require<Profile>('profiles', target.profile);
    service = profile.id;
  } else {
    const entity = getEntity(repository, target.service!, target.snapshot);
    const entry = server(entity);
    if (!entry?.path) invalid('Select a scanned MCP service with a launch command');
    path = entry.path;
    const source = historical || mode === 'isolated' ? commitSource(project.root, commit) : undefined;
    if (source && !source.has(path)) invalid('Commit the MCP configuration before running this version', { path });
    if (source) repositorySource = { path, source };
    const document = source ? source.read(path) : sourceText(project.root, path);
    const config = parseMcpConfig(path, mcpConfigDocument(path, document), []).find(
      (candidate) => candidate.name === entity.name,
    );
    const base = mapping(config?.definition.template);
    const template = { ...base, ...mapping(mapping(base.launch)[mode]) };
    if (!config || !isRunnable(template))
      invalid('The selected MCP configuration has no local launch command', { path });
    optionalEnvironment = Array.isArray(template.env_vars)
      ? [
          ...new Set(
            template.env_vars.filter(
              (item): item is string => typeof item === 'string' && /^(?!IFG_MCP_)[a-z_][a-z0-9_]*$/i.test(item),
            ),
          ),
        ].sort()
      : [];
    const env: Record<string, EnvRef> = {};
    for (const [name, value] of Object.entries(mapping(template.env))) {
      const reference = environmentReference(value);
      if (typeof reference !== 'string')
        invalid('Use explicit environment references for the temporary launch', { name, path });
      Object.defineProperty(env, name, { value: { env: reference }, enumerable: true });
    }
    profile = validate<Profile>('profile', {
      schemaVersion: 1,
      id: repositoryProfile(entity.id),
      name: entity.name,
      mcp: {
        transport:
          typeof template.url === 'string'
            ? template.transport === 'sse' || template.type === 'sse'
              ? 'sse'
              : 'streamableHttp'
            : 'stdio',
        command: template.command,
        args: template.args,
        cwd: template.cwd,
        env,
        image: template.image,
        ...(typeof template.url === 'string' ? { headers: configuredHeaders(template.headers, path) } : {}),
        protocolVersion: mcpVersions.find((version) => version === template.protocolVersion),
        ...(typeof template.url === 'string' ? { url: template.url } : {}),
      },
    });
    service = entity.service;
  }
  if (target.protocol && profile.mcp) profile = { ...profile, mcp: { ...profile.mcp, protocolVersion: pin } };
  const plan =
    mode === 'native'
      ? await prepareNative(project, profile, commit, historical, path, optionalEnvironment)
      : await prepareSandbox(project, profile, commit, target.image, repositorySource);
  return { profile, plan, service, path };
}

export function assertMcpLaunch(plan: SandboxTarget['plan']) {
  if ('mode' in plan) {
    if (plan.issues.length)
      throw new AppError('MCP_NATIVE_INCOMPATIBLE', 'The reviewed command cannot run on this host', 2, {
        issues: plan.issues,
      });
  } else assertSandboxLaunch(plan);
}

export function requireApproval(expected: string, supplied?: string) {
  if (expected !== supplied)
    throw new AppError(
      'MCP_SANDBOX_APPROVAL',
      'Review the current MCP plan and use its fingerprint to approve this run',
      2,
    );
}

export async function testTargets(
  project: ProjectPaths,
  repository: Repository,
  test: Plan,
  ref?: string,
  snapshot?: string,
) {
  const targets: SandboxTargets = new Map();
  const selections = new Map<string, SandboxTarget>();
  for (const step of test.steps) {
    if (step.request.kind !== 'mcp') continue;
    if (!step.profile) invalid('Select an isolated MCP profile for each MCP test', { case: step.id });
    const selection = step.request.service ? { service: step.request.service } : { profile: step.profile };
    const { image, mode, protocol } = step.request;
    const options = { ...selection, image, mode, protocol };
    const key = stableJson(options);
    let target = selections.get(key);
    if (!target) {
      target = await mcpTarget(project, repository, { ...options, ref, snapshot });
      selections.set(key, target);
    }
    targets.set(step, target);
  }
  const plans = [...selections.values()].map((item) => ({ profile: item.profile.id, ...item.plan }));
  const fingerprint = plans.length
    ? digest(stableJson({ plans, steps: test.steps.map((step) => [step.id, step.digest]) }))
    : null;
  return { plans, fingerprint, targets };
}
