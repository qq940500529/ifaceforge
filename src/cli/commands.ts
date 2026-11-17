type Usage = {
  name: string;
  usage: string;
  options: string[];
  position?: 'id' | 'query';
  writes: boolean;
  example: string;
};
const list = ['limit', 'offset'];
const search = ['kind', 'service', 'origin', 'state', ...list];
const wiki = ['snapshot', 'out', 'lang'];
const sandbox = ['profile', 'service', 'image', 'ref', 'mode', 'protocol'];

function command(
  name: string,
  suffix = '',
  options: string[] = [],
  writes = false,
  position?: Usage['position'],
): Usage {
  return {
    name,
    usage: 'ifg ' + name + (suffix ? ' ' + suffix : ''),
    options,
    writes,
    position,
    example: 'ifg ' + name + (suffix ? ' ' + suffix.replace(/[<>]/g, '') : '') + ' --json',
  };
}
function records(type: 'case' | 'suite') {
  return [
    command(type + ' list', '', list),
    command(type + ' show', 'demo', [], false, 'id'),
    command(type + ' put', '--file ' + type + '.json', ['file', 'replace', 'version'], true),
    command(type + ' remove', 'demo', [], true, 'id'),
    command(type + ' export', 'demo', [], false, 'id'),
  ];
}

export const commands: Usage[] = [
  command('project list'),
  command('project add', '<directory>', ['exact'], true, 'id'),
  command('project inspect', '<directory>', [], false, 'id'),
  command('project select', '<project-id>', [], true, 'id'),
  command('project relocate', '<project-id> --directory <directory>', ['directory', 'use-worktree'], true, 'id'),
  command('project hide', '<project-id>', [], true, 'id'),
  command('project delete', '<project-id> --confirm', ['confirm'], true, 'id'),
  command('preferences get'),
  command('preferences set', '--lang zh-CN', ['lang'], true),
  command('update check'),
  command('update open'),
  command('service status'),
  command('service stop', '', ['force'], true),
  command('task list', '', ['all']),
  command('task show', '<task-id>', [], false, 'id'),
  command('task watch', '<task-id>', ['stream'], false, 'id'),
  command('task cancel', '<task-id>', [], true, 'id'),
  command('status'),
  command('config show'),
  command('config validate', '--file .ifaceforge.json', ['file']),
  command('config apply', '--file settings.json', ['file'], true),
  command('profile list', '', list),
  command('profile show', 'demo', [], false, 'id'),
  command('profile put', '--file profile.json', ['file'], true),
  command('profile remove', 'demo', [], true, 'id'),
  command('scan', '--include-untracked', ['full', 'include-untracked', 'require-complete'], true),
  command('scan start', '', ['full', 'include-untracked'], true),
  command('git branches', '', [...list, 'query']),
  command('git log', '--ref main --format graph', [...list, 'ref', 'query', 'format']),
  command('git commit', 'HEAD', [], false, 'id'),
  command('git browse', '--ref main', ['ref', 'full', 'async'], true),
  command('git view'),
  command('git select', '--base main --target HEAD --mode commits', ['base', 'target', 'mode', 'ancestor'], true),
  command('git relation', '--base main --target HEAD', ['base', 'target']),
  command('compare', '--base main --target HEAD', [
    'base',
    'target',
    'mode',
    'ancestor',
    'kind',
    'service',
    'state',
    'query',
    'format',
    'out',
    'replace',
    'async',
  ]),
  command('compare file', '--base main --target HEAD --path README.md', [
    'base',
    'target',
    'path',
    'previous',
    'format',
    'out',
    'replace',
  ]),
  command('guide show', '--lang en', ['lang']),
  command('guide cli'),
  command('guide validate', '--ref HEAD', ['ref', 'snapshot']),
  command('guide serve'),
  command('scan list', '', list),
  command('scan show', '<snapshot-id>', [], false, 'id'),
  command('scan diff', '--from <snapshot-id> --to <snapshot-id>', ['from', 'to']),
  command('catalog search', 'tasks', [...search, 'ref', 'snapshot'], false, 'query'),
  command('catalog list', '', [...search, 'ref', 'snapshot']),
  command('catalog show', '<capability-id>', ['ref', 'snapshot'], false, 'id'),
  command('source show', '--path README.md', ['path', 'ref', 'snapshot']),
  command('api import', '--file openapi.yaml', ['file', 'url', 'profile', 'service'], true),
  command('api draft', '<capability-id>', ['ref', 'snapshot'], false, 'id'),
  command('api preview', '--file request.json --profile demo', ['file', 'profile']),
  command('api send', '--file request.json --profile demo', ['file', 'profile', 'assertions', 'async'], true),
  command('api curl', '--file request.json --profile demo', ['file', 'profile']),
  command('api export', '<capability-id>', ['format', 'ref', 'snapshot'], false, 'id'),
  command('mcp targets', '', ['ref', ...list]),
  command('mcp inventory', '--service <id>', ['profile', 'service', 'ref', 'mode', 'origin', ...list]),
  command('mcp plan', '--profile sample-stdio', [...sandbox, 'file']),
  command(
    'mcp probe',
    '--profile sample-stdio --approve <fingerprint>',
    [...sandbox, 'approve', 'assertions', 'async'],
    true,
  ),
  command(
    'mcp call',
    'echo --profile sample-stdio --args args.json',
    [...sandbox, 'approve', 'args', 'assertions', 'async'],
    true,
    'id',
  ),
  command(
    'mcp read',
    'task://42 --profile sample-stdio',
    [...sandbox, 'approve', 'assertions', 'async'],
    true,
    'id',
  ),
  command(
    'mcp template',
    'task://{id} --profile sample-stdio --args args.json',
    [...sandbox, 'approve', 'args', 'assertions', 'async'],
    true,
    'id',
  ),
  command(
    'mcp prompt',
    'task --profile sample-stdio --args args.json',
    [...sandbox, 'approve', 'args', 'assertions', 'async'],
    true,
    'id',
  ),
  command(
    'mcp batch',
    '--profile sample-stdio --file sequence.json',
    [...sandbox, 'approve', 'file', 'async'],
    true,
  ),
  command('skill list', '', [...list, 'ref', 'snapshot']),
  command('skill search', 'tasks', [...list, 'ref', 'snapshot'], false, 'query'),
  command('skill show', '<capability-id>', ['ref', 'snapshot'], false, 'id'),
  ...records('case'),
  ...records('suite'),
  command('test plan', '--case demo', ['case', 'suite', 'profile', 'ref']),
  command('test run', '--case demo', ['case', 'suite', 'profile', 'ref', 'approve', 'async'], true),
  command('run list', '', [...list, 'kind', 'state', 'profile']),
  command('run show', '<run-id>', [], false, 'id'),
  command('run cancel', '<run-id>', [], true, 'id'),
  command('run export', '<run-id>', [], false, 'id'),
  command('wiki preview', '--lang en', wiki),
  command('wiki build', '--lang zh-CN', wiki, true),
  command('wiki list', '', list),
  command('wiki show', '<export-id>', ['page', 'out', 'replace'], false, 'id'),
  command('wiki open', '<export-id>', [], false, 'id'),
  command('wiki note-show', '<capability-id>', [], false, 'id'),
  command('wiki note-put', '<capability-id> --file note.md', ['file'], true, 'id'),
  command('data backup', '--out project-backup.json', ['out'], true),
  command('data restore', '--file project-backup.json --replace', ['file', 'replace'], true),
  command('data prune', '--before 2026-11-16', ['before', 'apply'], true),
  command('commands'),
  command('schema', 'case', [], false, 'id'),
];

export const booleanOptions = new Set([
  'json',
  'help',
  'version',
  'full',
  'include-untracked',
  'require-complete',
  'replace',
  'apply',
  'async',
  'confirm',
  'exact',
  'use-worktree',
  'all',
  'stream',
  'force',
]);
export const globalOptions = ['project', 'json', 'help'];
export const commandNames = new Set([
  ...commands
    .filter(
      (item) =>
        !/^(?:project |preferences |update |task |service |scan start$|git select$|commands$|schema$|guide (?:serve|cli)$)/.test(
          item.name,
        ),
    )
    .map((item) => item.name),
  'git preference',
  'git task',
  'git cancel',
  'project',
  'wiki open',
]);

export function commandReference() {
  return {
    globalOptions,
    items: commands.map((item) => ({
      ...item,
      parameters: item.options.map((name) => ({
        flag: '--' + name,
        type: booleanOptions.has(name)
          ? 'boolean'
          : ['limit', 'offset', 'version'].includes(name)
            ? 'integer'
            : 'string',
        repeatable: item.name === 'git log' && name === 'ref',
        ...(name === 'args'
          ? { input: 'json-object-or-file' }
          : ['file', 'assertions'].includes(name)
            ? { input: 'file' }
            : {}),
      })),
    })),
    exitCodes: {
      0: 'success',
      1: 'assertion_failed',
      2: 'invalid_input',
      3: 'operation_failed',
      4: 'cancelled_interrupted_or_unknown',
    },
    automation: {
      guide: 'ifg guide cli',
      inputSchemas: 'ifg schema <name> --json',
      projectDiscovery: 'ifg project list --json',
      taskProgress: 'ifg task watch <id> --stream',
      taskCancellation: 'ifg task cancel <id> --json',
      mutatingCommands: 'items[].writes',
    },
  };
}
