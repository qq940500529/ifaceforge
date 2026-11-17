#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { failure, invalid } from '../app/errors.js';
import { parseJson, readJson } from '../app/files.js';
import { Projects } from '../storage/projects.js';
import { locateProject } from '../app/project.js';
import { Workbench, type CommandInput } from '../app/workbench.js';
import { openProjectDatabase } from '../storage/database.js';
import { Repository } from '../storage/repository.js';
import { schemas } from '../schemas/index.js';
import { booleanOptions, commandReference, commands, globalOptions } from './commands.js';
import { openLocation, version } from '../app/platform.js';
import { cliGuide, guide } from '../app/guides.js';
import { textGraph } from '../app/git-graph.js';
import type { gitLog } from '../app/git-history.js';
import type { VersionReport } from '../app/version-compare.js';
import { referencedEnvironment } from '../protocols/variables.js';
import { catalog } from '../app/catalog.js';
import { mapping } from '../scanner/openapi.js';
import { globalWorkspace, projectWorkspace, type CliInput } from './workspace.js';
import type { Run } from '../app/runs.js';

function envelope(command: string, data: unknown, error: unknown = null) {
  return { schemaVersion: 1, ok: error === null, command, data, error };
}

function presentation(name: string, input: CliInput, data: unknown) {
  if (name === 'git log' && input.format) {
    if (input.format !== 'graph' && input.format !== 'json') invalid('Expected graph or json format');
    const history = data as Awaited<ReturnType<typeof gitLog>>;
    if (input.format === 'graph')
      return { data: { ...history, graph: textGraph(history.items) }, text: textGraph(history.items) + '\n' };
  }
  if (name === 'compare' && !input.async) {
    const report = data as VersionReport;
    const kind = String(input.kind ?? '');
    if (kind && !['api', 'mcp', 'skill', 'files', 'diagnostics', 'all'].includes(kind))
      invalid('Unknown comparison kind');
    if (input.state && !['added', 'removed', 'changed'].includes(input.state))
      invalid('Unknown comparison status');
    if (input.format && !['json', 'markdown'].includes(input.format)) invalid('Expected json or markdown format');
    const filters = { kind: input.kind, service: input.service, state: input.state, query: input.query };
    const changes = report.changes.filter(
      (change) =>
        (!kind || kind === 'all' || kind === change.kind) &&
        (!input.service || input.service === change.service) &&
        (!input.state || input.state === change.status) &&
        (!input.query || change.name.toLowerCase().includes(input.query.toLowerCase())),
    );
    const result = { ...report, changes, filters };
    const lines = ['# IfaceForge comparison', '', report.effectiveBase + ' → ' + report.target.sha, ''];
    if (kind === 'files')
      lines.push(
        ...report.files.map(
          (file) => '- ' + file.status + ' ' + (file.previous ? file.previous + ' → ' : '') + file.path,
        ),
      );
    else if (kind === 'diagnostics')
      lines.push(
        ...[...report.base.diagnostics, ...report.target.diagnostics].map(
          (issue) => '- ' + (issue.path ?? '') + ' ' + issue.code + ' ' + issue.message,
        ),
      );
    else lines.push(...changes.map((change) => '- ' + change.status + ' · ' + change.kind + ' · ' + change.name));
    return { data: result, text: input.format === 'markdown' ? lines.join('\n') + '\n' : undefined };
  }
  if (name === 'compare file' && input.format) {
    if (input.format !== 'patch' && input.format !== 'json') invalid('Expected patch or json format');
    if (input.format === 'patch') return { data, text: (data as { text: string }).text };
  }
  if (name === 'wiki show' && input.out) {
    if (!input.page) invalid('Specify --page to export a single Wiki page');
    return { data, text: (data as { text: string }).text };
  }
  return { data };
}

async function main() {
  const raw = process.argv.slice(2);
  const json = raw.includes('--json');
  let name = '';
  let registry: Projects | undefined;
  let repository: Repository | undefined;
  let workbench: Workbench | undefined;
  const output = (data: unknown) =>
    process.stdout.write(JSON.stringify(json ? envelope(name, data) : data, null, json ? 0 : 2) + '\n');
  const interrupt = () => {
    void workbench?.executor.close();
  };
  try {
    const allOptions = [...new Set([...globalOptions, 'version', ...commands.flatMap((entry) => entry.options)])];
    let parsed;
    try {
      parsed = parseArgs({
        args: raw,
        allowPositionals: true,
        tokens: true,
        options: Object.fromEntries(
          allOptions.map((key) => [
            key,
            {
              type:
                key === 'version' && raw.some((arg) => arg === 'put')
                  ? 'string'
                  : booleanOptions.has(key)
                    ? 'boolean'
                    : 'string',
              ...(key === 'ref' ? { multiple: true } : {}),
            },
          ]),
        ),
      });
    } catch (error) {
      invalid((error as Error).message);
    }
    const { positionals, values, tokens } = parsed;
    const desc = [...commands]
      .sort((a, b) => b.name.length - a.name.length)
      .find((entry) => entry.name.split(' ').every((word, index) => positionals[index] === word));
    if (values.version === true) {
      name = 'version';
      if (json) output({ version });
      else process.stdout.write(version + '\n');
      return;
    }
    if (values.help || (!positionals.length && !json)) {
      name = 'help';
      const usage = desc
        ? desc.usage
        : 'Usage: ifg <command> [--project <id|directory>] [--json]\n\n' +
          commands.map((entry) => entry.usage).join('\n');
      if (json) output({ usage });
      else process.stdout.write(usage + '\n');
      return;
    }
    name = desc?.name ?? positionals.join(' ');
    if (!desc) invalid('Unknown command. Use ifg --help.');
    const parameters = positionals.slice(desc.name.split(' ').length);
    if (parameters.length !== (desc.position ? 1 : 0)) invalid('Expected ' + desc.usage);
    const input: Record<string, unknown> = {};
    if (desc.position) input[desc.position] = parameters[0];
    const used = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== 'option') continue;
      const key = token.name;
      if (used.has(key)) {
        if (key === 'ref' && name === 'git log') continue;
        invalid('Duplicate option', { key });
      }
      used.add(key);
      if (globalOptions.includes(key)) continue;
      if (!desc.options.includes(key)) invalid('Unsupported option for ' + name, { key });
      const value = values[key];
      const field =
        name.startsWith('mcp ') && key === 'mode'
          ? 'mcpMode'
          : key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      if (['limit', 'offset', 'version'].includes(key)) {
        if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
          invalid('Expected numeric option', { key });
        input[field] = Number(value);
      } else if (key === 'ref') {
        const refs = value as string[];
        if (name === 'git log') input.refs = refs;
        else input.ref = refs[0];
      } else input[field] = value;
    }
    if (name === 'commands') {
      output(commandReference());
      return;
    }
    if (name === 'guide cli') {
      if (json) output({ markdown: cliGuide(), commands: commandReference() });
      else process.stdout.write(cliGuide());
      return;
    }
    if (name === 'guide show') {
      const language = input.lang ?? 'en';
      if (language !== 'en' && language !== 'zh-CN') invalid('Unsupported guide language');
      if (json) output(guide(language));
      else process.stdout.write(guide(language).markdown);
      return;
    }
    if (name === 'guide serve') {
      if (json) invalid('The guide server uses MCP over stdio');
      const { serveGuides } = await import('./guide-server.js');
      serveGuides();
      return;
    }
    if (name === 'schema') {
      const id = String(input.id);
      if (!Object.hasOwn(schemas, id)) invalid('Unknown schema', { id, available: Object.keys(schemas) });
      output(schemas[id]);
      return;
    }
    if ([input.file, input.args, input.assertions].filter((value) => value === '-').length > 1)
      invalid('stdin can only be read once');
    if (typeof input.file === 'string' && !['api import', 'data restore'].includes(name)) {
      input.body =
        name === 'wiki note-put'
          ? readFileSync(input.file === '-' ? 0 : input.file, 'utf8')
          : readJson(input.file);
    }
    if (typeof input.args === 'string') {
      input.args = input.args.trimStart().startsWith('{') ? parseJson(input.args) : readJson(input.args);
    }
    if (typeof input.assertions === 'string') input.assertions = readJson(input.assertions);
    registry = new Projects();
    const cliInput = input as CliInput;
    const selector = typeof values.project === 'string' ? values.project : process.cwd();
    const records = registry.list();
    const knownProject = records.find((item) => item.id === selector);
    if (name.startsWith('task ') && typeof values.project === 'string' && !knownProject) {
      const root = locateProject(selector);
      if (!records.some((project) => project.root === root)) invalid('Project is not registered', { root });
    }
    const taskProject =
      typeof values.project === 'string' && name.startsWith('task ')
        ? (knownProject?.id ?? records.find((item) => item.root === locateProject(selector))?.id)
        : undefined;
    const global = await globalWorkspace(name, cliInput, taskProject, (task) => {
      if (cliInput.stream) process.stdout.write(JSON.stringify({ schemaVersion: 1, event: 'task', task }) + '\n');
      else if (!json)
        process.stderr.write(
          ('state' in task
            ? task.state +
              ' ' +
              task.stage +
              ' ' +
              task.processed +
              (task.total === undefined ? '' : '/' + task.total)
            : task.status + ' ' + task.steps.length) + '\n',
        );
    });
    if (global) {
      if (name === 'task watch') {
        const task = global.data as { state?: string; status?: string; exitCode?: number };
        process.exitCode = task.exitCode ?? (task.state === 'cancelled' ? 4 : task.state === 'failed' ? 3 : 0);
      }
      if (!cliInput.stream) output(global.data);
      return;
    }
    if (name === 'project list') {
      output(records);
      return;
    }
    if (name === 'project add') {
      const path = resolve(String(input.id));
      const root = locateProject(path);
      if (cliInput.exact && realpathSync.native(path) !== root) invalid('Choose the worktree root', { root });
      output(registry.add(root));
      return;
    }
    let id = knownProject?.id;
    if (!id) {
      try {
        const root = locateProject(selector);
        id = records.find((item) => item.root === root && !item.hidden)?.id ?? registry.add(root).id;
      } catch (error) {
        const selected = typeof values.project === 'string' ? undefined : registry.preference('selected');
        if (!selected || !records.some((item) => item.id === selected && !item.hidden)) throw error;
        id = selected;
      }
    }
    const paths = registry.paths(id);
    repository = new Repository(openProjectDatabase(paths));
    if (cliInput.async && cliInput.out) invalid('Wait for the task before writing its output');
    const repositoryMcp =
      name.startsWith('mcp ') && typeof input.service === 'string'
        ? catalog(repository).find((entry) => entry.id === input.service)
        : undefined;
    const serverConfig = mapping(
      repositoryMcp?.observations.find((entry) => entry.definition.type === 'server')?.definition.template,
    );
    const mcpEnvironment = [serverConfig, ...Object.values(mapping(serverConfig.launch)).map(mapping)].flatMap(
      (config) => [
        ...(Array.isArray(config.env_vars) ? config.env_vars : []),
        ...Object.values(mapping(config.env)).flatMap((value) => {
          if (typeof value !== 'string') return [];
          const ref = /^\$\{(?:env:)?([a-z_][a-z0-9_]*)\}$/i.exec(value);
          return ref ? [ref[1]] : [];
        }),
      ],
    );
    const env = /^(?:api (?:preview|send|curl)|mcp |test run)/.test(name)
      ? referencedEnvironment([
          input,
          repository.list('profiles'),
          ...mcpEnvironment
            .filter((name) => typeof name === 'string' && /^[a-z_][a-z0-9_]*$/i.test(name))
            .map((name) => ({ env: name })),
          ...(name === 'test run' ? [repository.list('cases')] : []),
        ])
      : undefined;
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const remote = await projectWorkspace(name, id, cliInput, env);
    if (!remote) workbench = new Workbench(paths, repository);
    const data = remote ? remote.data : await workbench!.execute(name, input as CommandInput);
    if (name === 'wiki open') openLocation((data as { out: string }).out);
    const run = data as Partial<Run> | undefined;
    if (run?.exitCode && !['run show', 'run export', 'run cancel'].includes(name)) {
      process.exitCode = run.exitCode;
      const error = {
        code: run.steps?.find((step) => step.error)?.error?.code ?? 'ASSERTION_FAILED',
        message: 'Run did not pass',
        details: { runId: run.id, status: run.status },
      };
      if (json) process.stdout.write(JSON.stringify(envelope(name, data, error)) + '\n');
      else {
        output(data);
        process.stderr.write(error.message + '\n');
      }
    } else {
      const result = presentation(name, cliInput, data);
      if (cliInput.out && ['compare', 'compare file', 'wiki show'].includes(name)) {
        const path = resolve(cliInput.out);
        writeFileSync(path, result.text ?? JSON.stringify(result.data, null, 2) + '\n', {
          flag: cliInput.replace ? 'w' : 'wx',
          mode: 0o600,
        });
        output({ out: path, format: cliInput.format ?? (name === 'wiki show' ? 'markdown' : 'json') });
      } else if (!json && result.text !== undefined) process.stdout.write(result.text);
      else output(result.data);
    }
  } catch (error) {
    const err = failure(error);
    process.exitCode = err.exitCode;
    process.send?.({ code: err.code, message: err.message });
    if (json) {
      process.stdout.write(
        JSON.stringify(envelope(name, null, { code: err.code, message: err.message, details: err.details })) +
          '\n',
      );
    } else process.stderr.write(err.code + ': ' + err.message + '\n');
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await workbench?.executor.close();
    repository?.db.close();
    registry?.close();
  }
}

void main();
