#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { failure, invalid } from '../app/errors.js';
import { parseJson, readJson } from '../app/files.js';
import { resolveProject } from '../app/project.js';
import { Workbench, type CommandInput } from '../app/workbench.js';
import { openProjectDatabase } from '../storage/database.js';
import { Repository } from '../storage/repository.js';
import { schemas } from '../schemas/index.js';
import { booleanOptions, commands, globalOptions } from './commands.js';
import { instanceResult, openLocation, version } from '../server/instance.js';
import { serve } from '../server/web.js';
import type { Run } from '../app/runs.js';

function envelope(command: string, data: unknown, error: unknown = null) {
  return { schemaVersion: 1, ok: error === null, command, data, error };
}

async function main() {
  const raw = process.argv.slice(2);
  const json = raw.includes('--json');
  let name = '';
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
        : 'Usage: ifg <command> [--project <path>] [--json]\n\n' + commands.map((entry) => entry.usage).join('\n');
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
      if (used.has(key)) invalid('Duplicate option', { key });
      used.add(key);
      if (globalOptions.includes(key)) continue;
      if (!desc.options.includes(key)) invalid('Unsupported option for ' + name, { key });
      const value = values[key];
      const field = key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      if (['limit', 'offset', 'port', 'version'].includes(key)) {
        if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
          invalid('Expected numeric option', { key });
        input[field] = Number(value);
      } else input[field] = value;
    }
    if (name === 'commands') {
      output({ globalOptions, items: commands });
      return;
    }
    if (name === 'schema') {
      const id = String(input.id);
      if (!Object.hasOwn(schemas, id)) invalid('Unknown schema', { id, available: Object.keys(schemas) });
      output(schemas[id]);
      return;
    }
    if (typeof input.file === 'string' && !['api import', 'data restore'].includes(name)) {
      input.body =
        name === 'wiki note-put'
          ? readFileSync(input.file === '-' ? 0 : input.file, 'utf8')
          : readJson(input.file);
    }
    if (typeof input.args === 'string') {
      if (input.file === '-' && input.args === '-') invalid('stdin can only be read once');
      input.args = input.args.trimStart().startsWith('{') ? parseJson(input.args) : readJson(input.args);
    }
    const project = resolveProject(typeof values.project === 'string' ? values.project : process.cwd());
    repository = new Repository(openProjectDatabase(project));
    workbench = new Workbench(project, repository);
    if (name === 'start' && input.foreground) {
      if (input.port === 0) invalid('Explicit port must be between 1 and 65535');
      const server = await serve(workbench, input.port as number | undefined);
      process.send?.({ instance: server.instance });
      process.on('SIGINT', () => {
        void server.stop();
      });
      process.on('SIGTERM', () => {
        void server.stop();
      });
      if (!input.noOpen) openLocation(server.instance.url);
      output({ project: project.root, ...instanceResult(server.instance) });
      await server.finished;
      return;
    }
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const data = await workbench.execute(name, input as CommandInput);
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
    } else output(data);
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
    repository?.db.close();
  }
}

void main();
