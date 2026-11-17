import { expect, it } from 'vitest';
import { scanPythonHttp } from '../../src/scanner/python-http.js';
import { pythonConstants } from '../../src/scanner/python-constants.js';
import { pythonRouteTemplates } from '../../src/scanner/python-route-pattern.js';
import type { Diagnostic } from '../../src/scanner/model.js';

it.each([
  [
    '/items/(?P<sku>[^/]+)(?:/(archive|restore))?',
    ['/items/{sku}', '/items/{sku}/archive', '/items/{sku}/restore'],
  ],
  [
    '/reports/(\\d{1,6}\\.\\d{1,6}\\.\\d{1,6})/(summary|data)',
    ['/reports/{param1}/summary', '/reports/{param1}/data'],
  ],
  [
    '/groups/([0-9a-f-]{36})(/index|/pages/([1-9][0-9]*))',
    ['/groups/{param1}/index', '/groups/{param1}/pages/{param2}'],
  ],
  ['/files/(.*)', ['/files/{param1}']],
])('projects bounded regex paths %s', (pattern, result) => {
  expect(pythonRouteTemplates(pattern)).toEqual(result);
});

it.each(['/a/(?=x)/x', '/a/(.*)/end', '/a/([^x]+)', '/a/([x/]+)', '/a/(a|b){100}', '/a/' + '(a|b)'.repeat(8)])(
  'leaves unsupported regex paths unresolved %s',
  (pattern) => {
    expect(pythonRouteTemplates(pattern)).toBeUndefined();
  },
);

it('uses positive full-match evidence and ignores request comparisons and route exemptions', () => {
  const source = `from http.server import BaseHTTPRequestHandler
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        parsed = urlsplit(self.path)
        if len(self.path) > 2048 and not (self.command == "GET" and re.fullmatch(r"/guard-only", parsed.path)):
            raise ValueError()
        if self.path != parsed.path:
            raise ValueError()
        if parsed.path == "/records":
            return submit()
        match = re.fullmatch(r"/records/" r"(?P<id>[0-9a-f-]{36})", parsed.path)
        if match is not None:
            return replace(match)
        if re.fullmatch(dynamic_pattern, parsed.path):
            return fallback()
    def check(self):
        if self.path != "/records":
            raise ValueError()
`;
  const diagnostics: Diagnostic[] = [];
  const routes = scanPythonHttp('service.py', source, 'demo', diagnostics);
  expect(routes.map((route) => route.name)).toEqual(['POST /records', 'POST /records/{id}']);
  expect(routes[1].definition.pathPattern).toBe('/records/(?P<id>[0-9a-f-]{36})');
  expect(diagnostics).toMatchObject([{ line: 14, code: 'HTTP_HANDLER_UNRESOLVED' }]);
});

it('follows method guards and constants using relative and absolute module aliases', () => {
  const files = new Map([
    ['src/example/paths.py', 'PREFIX: str = "/items/"\nMATCH = r"(?P<id>[0-9]+)"\n'],
    ['src/example/settings.py', 'from .paths import PREFIX\nCHANNEL = PREFIX + "stable"'],
  ]);
  const source = `from . import paths
from .paths import MATCH as pattern
import example.settings as config
def route(method, path):
    if method != "GET":
        return None
    if path == config.CHANNEL:
        return "channel"
    if (match := re.fullmatch(paths.PREFIX + pattern, path)) is not None:
        return match
`;
  const diagnostics: Diagnostic[] = [];
  const routes = scanPythonHttp(
    'src/example/service.py',
    source,
    'demo',
    diagnostics,
    undefined,
    pythonConstants((path) => files.get(path)),
  );
  expect(routes.map((route) => route.name)).toEqual(['GET /items/stable', 'GET /items/{id}']);
  expect(diagnostics).toEqual([]);
});

it('keeps optional captures bound to their method branches and dispatch-table entries', () => {
  const source = `def dispatch(method, path):
    match = re.fullmatch(r"/jobs/([0-9]+)(/pause|/resume)?", path)
    if match:
        job_id, action = match.groups()
        if action is None:
            return ("lookup", job_id) if method == "GET" else None
        operations = {("POST", "/pause"): "pause", ("PUT", "/resume"): "resume"}
        operation = (operations.get((method, match[2]))
                     if match[2] is not None else None)
        if operation is None:
            return None
        return operation, job_id
    if not method == "GET" or path != "/health":
        return None
    return "ready"
`;
  const diagnostics: Diagnostic[] = [];
  const routes = scanPythonHttp('jobs.py', source, 'demo', diagnostics);
  expect(routes.map((item) => item.name)).toEqual([
    'GET /jobs/{param1}',
    'POST /jobs/{param1}/pause',
    'PUT /jobs/{param1}/resume',
    'GET /health',
  ]);
  expect(diagnostics).toEqual([]);
});
