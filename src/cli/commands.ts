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
  command('project add', '<directory>', [], true, 'id'),
  command('status'),
  command('config show'),
  command('config validate', '--file .ifaceforge.json', ['file']),
  command('config apply', '--file settings.json', ['file'], true),
  command('profile list', '', list),
  command('profile show', 'demo', [], false, 'id'),
  command('profile put', '--file profile.json', ['file'], true),
  command('profile remove', 'demo', [], true, 'id'),
  command('scan', '--include-untracked', ['full', 'include-untracked', 'require-complete'], true),
  command('scan list', '', list),
  command('scan show', '<snapshot-id>', [], false, 'id'),
  command('scan diff', '--from <snapshot-id> --to <snapshot-id>', ['from', 'to']),
  command('catalog search', 'tasks', search, false, 'query'),
  command('catalog list', '', search),
  command('catalog show', '<capability-id>', [], false, 'id'),
  command('source show', '--path README.md', ['path']),
  command('api import', '--file openapi.yaml', ['file', 'url', 'profile', 'service'], true),
  command('api draft', '<capability-id>', [], false, 'id'),
  command('api preview', '--file request.json --profile demo', ['file', 'profile']),
  command('api send', '--file request.json --profile demo', ['file', 'profile'], true),
  command('api curl', '--file request.json --profile demo', ['file', 'profile']),
  command('api export', '<capability-id>', ['format'], false, 'id'),
  command('mcp discover', '--profile sample-stdio', ['profile', 'service', 'assertions'], true),
  command(
    'mcp call',
    'echo --profile sample-stdio --args args.json',
    ['profile', 'args', 'assertions'],
    true,
    'id',
  ),
  command('mcp read', 'task://42 --profile sample-stdio', ['profile', 'assertions'], true, 'id'),
  command(
    'mcp template',
    'task://{id} --profile sample-stdio --args args.json',
    ['profile', 'args', 'assertions'],
    true,
    'id',
  ),
  command(
    'mcp prompt',
    'task --profile sample-stdio --args args.json',
    ['profile', 'args', 'assertions'],
    true,
    'id',
  ),
  command('mcp batch', '--profile sample-stdio --file sequence.json', ['profile', 'file', 'service'], true),
  command('skill list', '', list),
  command('skill search', 'tasks', list, false, 'query'),
  command('skill show', '<capability-id>', [], false, 'id'),
  ...records('case'),
  ...records('suite'),
  command('test run', '--case demo', ['case', 'suite', 'profile'], true),
  command('run list', '', [...list, 'kind', 'state', 'profile']),
  command('run show', '<run-id>', [], false, 'id'),
  command('run cancel', '<run-id>', [], true, 'id'),
  command('run export', '<run-id>', [], false, 'id'),
  command('wiki preview', '--lang en', wiki),
  command('wiki build', '--lang zh-CN', wiki, true),
  command('wiki list', '', list),
  command('wiki show', '<export-id>', ['page'], false, 'id'),
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
]);
export const globalOptions = ['project', 'json', 'help'];
export const commandNames = new Set([
  ...commands
    .filter((item) => !['project list', 'project add', 'commands', 'schema'].includes(item.name))
    .map((item) => item.name),
  'project',
  'mcp connect',
  'mcp disconnect',
  'wiki open',
]);
