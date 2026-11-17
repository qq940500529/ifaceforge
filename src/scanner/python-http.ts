import type { SyntaxNode } from '@lezer/common';
import { parser } from '@lezer/python';
import { apiId, type Diagnostic, type Observation } from './model.js';
import {
  pythonChildren as children,
  pythonConstants,
  pythonString,
  type PythonConstant,
} from './python-constants.js';
import { projectPythonPattern, type PythonRouteTemplate } from './python-route-pattern.js';

const verbs = /^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE)$/;
const testFile = /(?:^|\/)(?:tests?|testing)\/|(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i;
type Role = 'method' | 'path' | 'url';
type Route = { path: string; offset: number; pattern?: string; template?: PythonRouteTemplate };
type Capture = { capture: number; match: number };
type CaptureCheck = Capture & { value?: string | null; equal: boolean };
type Constraints = { methods?: string[]; paths?: Route[]; dynamic?: SyntaxNode; captures?: CaptureCheck[] };
type Binding = Role | Route[] | SyntaxNode | Capture | { choices: Constraints[] } | null;
type Known = Map<string, Binding>;

function syntax(value: Binding | undefined): value is SyntaxNode {
  return Boolean(value && typeof value === 'object' && 'name' in value);
}

function matchesCapture(route: Route, check: CaptureCheck) {
  const template = route.template;
  if (!template || route.offset !== check.match) return true;
  if (check.capture > template.groupCount) return false;
  const value = template.groups[check.capture] ?? null;
  if (value === true && check.value !== null) return false;
  return (check.value === undefined ? Boolean(value) : value === check.value) === check.equal;
}

export function pythonHttpCandidate(file: string, text: string) {
  return !testFile.test(file) && /\b(?:path|BaseHTTPRequestHandler|SimpleHTTPRequestHandler)\b/.test(text);
}

function combine(left: Constraints, right: Constraints): Constraints {
  const methods =
    left.methods && right.methods
      ? left.methods.filter((method) => right.methods!.includes(method))
      : (left.methods ?? right.methods);
  const paths =
    left.paths && right.paths
      ? left.paths.filter((route) => right.paths!.some((other) => other.path === route.path))
      : (left.paths ?? right.paths);
  const captures = [...(left.captures ?? []), ...(right.captures ?? [])];
  return {
    methods,
    paths: captures.length
      ? paths?.filter((route) => captures.every((check) => matchesCapture(route, check)))
      : paths,
    dynamic: left.dynamic ?? right.dynamic,
    captures: captures.length ? captures : undefined,
  };
}

export function scanPythonHttp(
  file: string,
  text: string,
  service: string,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
  constants = pythonConstants(),
) {
  if (!pythonHttpCandidate(file, text)) return [];
  const tree = parser.parse(text);
  const lookup = constants(file, text, tree.topNode);
  const routes = new Map<string, Observation>();
  const unresolved = new Map<number, string>();
  const unresolvedMethods = new Map<number, string>();
  const resolvedOffsets = new Set<number>();
  const lines = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines.push(i + 1);
  const line = (offset: number) => {
    let lo = 0,
      hi = lines.length;
    while (lo + 1 < hi) {
      const middle = (lo + hi) >>> 1;
      if (lines[middle] <= offset) lo = middle;
      else hi = middle;
    }
    return lo + 1;
  };
  const raw = (node: SyntaxNode) => text.slice(node.from, node.to);
  function strings(node: SyntaxNode, known: Known, global: PythonConstant): Route[] | undefined {
    const local = known.get(raw(node));
    if (Array.isArray(local)) return local.map((route) => ({ ...route, offset: node.from }));
    if (['TupleExpression', 'ArrayExpression', 'SetExpression'].includes(node.name)) {
      const items = children(node).filter((item) => !['(', ')', '[', ']', '{', '}', ','].includes(item.name));
      const values = items.map((item) => strings(item, known, global));
      return values.every((value) => value?.length === 1) ? (values.flat() as Route[]) : undefined;
    }
    const value = pythonString(node, raw, (name) => {
      const local = known.get(name.split('.')[0]);
      if (Array.isArray(local) && local.length === 1 && !name.includes('.')) return local[0].path;
      return known.has(name.split('.')[0]) ? undefined : global(name);
    });
    if (value !== undefined) return [{ path: value, offset: node.from }];
  }

  function record(scope: Constraints) {
    if (scope.paths?.length === 0 || scope.methods?.length === 0) return;
    for (const route of scope.paths ?? []) {
      if (!scope.methods?.length && !resolvedOffsets.has(route.offset))
        unresolvedMethods.set(route.offset, route.path);
      for (const method of scope.methods ?? []) {
        const id = apiId(service, method, route.path);
        const at = line(route.offset);
        const key = id + ':' + at;
        if (!routes.has(key))
          routes.set(key, {
            id,
            kind: 'api',
            service,
            name: method + ' ' + route.path,
            summary: '',
            origin: 'source',
            path: file,
            line: at,
            definition: {
              method: method.toLowerCase(),
              path: route.path,
              adapter: 'python-http',
              pathPattern: route.pattern,
            },
          });
        resolvedOffsets.add(route.offset);
        unresolved.delete(route.offset);
        unresolvedMethods.delete(route.offset);
      }
    }
    if (scope.dynamic) {
      const expression = raw(scope.dynamic).replace(/\s+/g, ' ').slice(0, 140);
      unresolved.set(scope.dynamic.from, 'HTTP path could not be determined from ' + expression);
    }
  }

  function scanFunction(fn: SyntaxNode, handlerClass: boolean) {
    const name = fn.getChild('VariableName');
    const params = fn.getChild('ParamList');
    const body = fn.getChild('Body');
    if (!name || !params || !body) return;
    const parameters = new Set(params.getChildren('VariableName').map(raw));
    const handler = [...parameters].some(
      (parameter) =>
        parameter !== 'self' &&
        raw(body).includes(parameter + '.path') &&
        raw(body).includes(parameter + '.command'),
    );
    const routeFunction =
      /(?:route|dispatch)/i.test(raw(name)) &&
      parameters.has('path') &&
      (parameters.has('method') || parameters.has('command'));
    if (!handlerClass && !handler && !routeFunction) return;
    const explicit = /^do_([A-Z]+)$/.exec(raw(name))?.[1];
    const initial: Constraints = explicit && verbs.test(explicit) ? { methods: [explicit] } : {};
    const aliases: Known = new Map([...parameters].map((parameter) => [parameter, null]));
    if (routeFunction) {
      aliases.set('path', 'path');
      aliases.set(parameters.has('method') ? 'method' : 'command', 'method');
    }
    function role(node: SyntaxNode, known: Known): Role | undefined {
      if (node.name === 'VariableName') {
        const value = known.get(raw(node));
        return typeof value === 'string' ? value : undefined;
      }
      if (node.name === 'MemberExpression') {
        const owner = node.firstChild;
        const member = node.lastChild;
        if (!owner || !member) return;
        if (raw(member) === 'path' && role(owner, known) === 'url') return 'path';
        if (owner.name === 'VariableName' && parameters.has(raw(owner)))
          return raw(member) === 'path' ? 'path' : raw(member) === 'command' ? 'method' : undefined;
      }
      if (node.name === 'CallExpression') {
        const callee = node.firstChild;
        const arg = node.getChild('ArgList')?.firstChild?.nextSibling;
        if (callee && arg && role(arg, known) === 'path') {
          if (/(?:^|\.)(?:urlsplit|urlparse)$/.test(raw(callee))) return 'url';
          if (/(?:^|\.)unquote$/.test(raw(callee))) return 'path';
        }
      }
    }

    function pathPattern(node: SyntaxNode, known: Known) {
      if (node.name !== 'CallExpression' || !node.firstChild || !/(?:^|\.)fullmatch$/.test(raw(node.firstChild)))
        return;
      const args = node.getChild('ArgList');
      if (args && children(args).some((item) => role(item, known) === 'path')) return node;
    }

    function patternConstraints(pattern: SyntaxNode, known: Known): Constraints[] {
      const args = pattern.getChild('ArgList');
      const items = args && children(args).filter((item) => !['(', ')', ','].includes(item.name));
      if (items?.length !== 2 || role(items[1], known) !== 'path') return [{ dynamic: pattern }];
      const regex = strings(items[0], known, lookup)?.[0]?.path;
      const paths = regex === undefined ? undefined : projectPythonPattern(regex);
      return paths
        ? [
            {
              paths: paths.map((template) => ({
                path: template.path,
                offset: pattern.from,
                pattern: regex,
                template,
              })),
            },
          ]
        : [{ dynamic: pattern }];
    }

    function capture(node: SyntaxNode, known: Known): Capture | undefined {
      if (node.name === 'VariableName') {
        const value = known.get(raw(node));
        return value && typeof value === 'object' && 'capture' in value ? value : undefined;
      }
      if (node.name !== 'MemberExpression') return;
      const [name, open, index, close] = children(node);
      if (!name || open?.name !== '[' || index?.name !== 'Number' || close?.name !== ']') return;
      const match = known.get(raw(name));
      const ordinal = Number(raw(index));
      if (syntax(match) && pathPattern(match, known) && Number.isInteger(ordinal) && ordinal > 0)
        return { match: match.from, capture: ordinal };
    }

    function dispatchTable(node: SyntaxNode, known: Known): Constraints[] | undefined {
      if (node.name !== 'CallExpression') return;
      const member = node.firstChild;
      const owner = member?.firstChild;
      if (!member || !owner || member.name !== 'MemberExpression' || raw(member.lastChild!) !== 'get') return;
      const table = owner.name === 'VariableName' ? known.get(raw(owner)) : owner;
      if (!syntax(table) || table.name !== 'DictionaryExpression') return;
      const arg = node.getChild('ArgList');
      const inputs = arg && children(arg).filter((item) => !['(', ')', ','].includes(item.name));
      if (inputs?.length !== 1) return;
      const tuple = (node: SyntaxNode) =>
        node.name === 'TupleExpression'
          ? children(node).filter((item) => !['(', ')', ','].includes(item.name))
          : [node];
      const keys = tuple(inputs[0]);
      const locations = keys.map((key) => capture(key, known) ?? role(key, known));
      if (
        !locations.includes('method') ||
        locations.some((value) => !value || value === 'path' || value === 'url')
      )
        return;
      const result: Constraints[] = [];
      const entries = children(table).filter((item) => !['{', '}', ','].includes(item.name));
      if (!entries.length || entries.length % 3 !== 0 || entries.length > 96) return;
      for (let index = 0; index < entries.length; index += 3) {
        const literals = tuple(entries[index]);
        if (entries[index + 1].name !== ':' || literals.length !== keys.length) return;
        if (entries[index + 2].name === 'None') continue;
        let row: Constraints = {};
        for (const [position, location] of locations.entries()) {
          const value =
            literals[position].name === 'None' ? null : strings(literals[position], known, lookup)?.[0]?.path;
          if (value === undefined) return;
          if (location === 'method') {
            if (typeof value !== 'string' || !verbs.test(value)) return;
            row = combine(row, { methods: [value] });
          } else if (typeof location === 'object') {
            row = combine(row, { captures: [{ ...location, value, equal: true }] });
          }
        }
        result.push(row);
      }
      return result;
    }

    function dispatchChoices(node: SyntaxNode, known: Known, depth = 0): Constraints[] | undefined {
      if (depth >= 8) return;
      if (node.name === 'ParenthesizedExpression') {
        const value = children(node)[1];
        return value && dispatchChoices(value, known, depth + 1);
      }
      if (node.name === 'VariableName') {
        const value = known.get(raw(node));
        return value && typeof value === 'object' && 'choices' in value ? value.choices : undefined;
      }
      if (node.name === 'ConditionalExpression') {
        const [yes, , test, , no] = children(node);
        if (!yes || !test || !no) return;
        const valued = (value: SyntaxNode) =>
          value.name === 'None'
            ? []
            : (dispatchChoices(value, known, depth + 1) ?? (pythonString(value, raw, lookup) ? [{}] : undefined));
        const positive = valued(yes);
        const negative = valued(no);
        if (!positive || !negative) return;
        const paths = (choices: Constraints[], inverse: boolean) =>
          condition(test, known, inverse).flatMap((guard) => choices.map((item) => combine(guard, item)));
        return [...paths(positive, false), ...paths(negative, true)].slice(0, 32);
      }
      return dispatchTable(node, known);
    }

    function condition(node: SyntaxNode, known: Known, inverse = false, negateFirst = false): Constraints[] {
      const parts = children(node);
      if (node.name === 'ParenthesizedExpression' && parts.length === 3)
        return condition(parts[1], known, inverse !== negateFirst);
      if (node.name === 'UnaryExpression' && parts[0]?.name === 'not' && parts[1])
        return condition(parts[1], known, inverse, !negateFirst);
      const operator = node.name === 'BinaryExpression' ? parts.slice(1, -1).map(raw).join(' ') : '';
      const left = parts[0];
      const right = parts.at(-1)!;
      if (operator === 'and' || operator === 'or') {
        // Lezer can attach a leading "not" above the whole Boolean expression.
        // Python applies it to the first operand unless there are parentheses.
        const a = condition(left, known, inverse, negateFirst);
        const b = condition(right, known, inverse);
        return (operator === 'and') !== inverse
          ? a.flatMap((item) => b.map((other) => combine(item, other))).slice(0, 32)
          : [...a, ...b].slice(0, 32);
      }
      inverse = inverse !== negateFirst;
      const checked = capture(node, known);
      if (checked) return [{ captures: [{ ...checked, equal: !inverse }] }];
      if (!inverse) {
        const pattern = node.name === 'VariableName' ? known.get(raw(node)) : node;
        if (syntax(pattern) && pathPattern(pattern, known)) return patternConstraints(pattern, known);
        const choices = dispatchChoices(node, known);
        if (choices) return choices;
      }
      if (node.name === 'NamedExpression' && parts.at(-1)) return condition(parts.at(-1)!, known, inverse);
      if (node.name !== 'BinaryExpression' || parts.length < 3) return [{}];
      if (['is', 'is not', '==', '!='].includes(operator)) {
        const leftCapture = capture(left, known);
        const check = leftCapture ?? capture(right, known);
        const value = leftCapture ? right : left;
        const literal = value.name === 'None' ? null : strings(value, known, lookup)?.[0]?.path;
        if (check && literal !== undefined)
          return [
            {
              captures: [
                { ...check, value: literal, equal: (operator === 'is' || operator === '==') !== inverse },
              ],
            },
          ];
        const match = left.name === 'None' ? right : right.name === 'None' ? left : undefined;
        if (match && (operator === 'is not' || operator === '!=') !== inverse) return condition(match, known);
      }
      if (!(inverse ? ['!=', 'not in'] : ['==', 'in']).includes(operator)) return [{}];
      if (role(left, known) && role(right, known)) return [{}];
      const ref = role(left, known) ?? (operator.endsWith('in') ? undefined : role(right, known));
      const value = role(left, known) ? right : left;
      if (ref === 'method') {
        const methods = strings(value, known, lookup)
          ?.map((item) => item.path)
          .filter((item) => verbs.test(item));
        return methods?.length ? [{ methods }] : [{}];
      }
      if (ref === 'path') {
        const paths = strings(value, known, lookup)?.filter((item) => /^\/(?!\/)[^?#\s]*$/.test(item.path));
        return paths?.length ? [{ paths }] : [{ dynamic: node }];
      }
      return [{}];
    }

    function walk(block: SyntaxNode, inherited: Constraints[], known: Known) {
      let current = inherited;
      const accept = (constraints: Constraints[], guard = false) => {
        if (guard) {
          const paths = constraints.every((item) => item.paths || item.dynamic);
          const methods = constraints.every((item) => item.methods);
          const captures = constraints.every((item) => item.captures);
          constraints = constraints.map((item) => ({
            paths: paths ? item.paths : undefined,
            dynamic: paths ? item.dynamic : undefined,
            methods: methods ? item.methods : undefined,
            captures: captures ? item.captures : undefined,
          }));
        }
        const combined = current.flatMap((item) => constraints.map((next) => combine(item, next))).slice(0, 32);
        const matched = guard
          ? new Set(current.flatMap((item) => item.paths?.map((route) => route.offset) ?? []))
          : undefined;
        for (const clause of combined) {
          if (
            !matched ||
            (!clause.dynamic && clause.paths?.every((route) => !route.pattern || matched.has(route.offset)))
          )
            record(clause);
        }
        return combined;
      };
      for (const statement of children(block)) {
        if (statement.name === 'AssignStatement') {
          const parts = children(statement);
          const assign = parts.findIndex((part) => part.name === 'AssignOp' && raw(part) === '=');
          if (assign < 0) continue;
          const left = parts.slice(0, assign).filter((part) => part.name !== ',' && part.name !== 'TypeDef');
          const right = parts.slice(assign + 1).filter((part) => part.name !== ',');
          const callable =
            right.length === 1 && right[0].name === 'CallExpression' ? right[0].firstChild : undefined;
          const matched =
            callable?.lastChild && raw(callable.lastChild) === 'groups' && callable.firstChild
              ? known.get(raw(callable.firstChild))
              : undefined;
          if (left.length > 1 && syntax(matched) && pathPattern(matched, known)) {
            for (const [index, item] of left.entries()) {
              if (item.name === 'VariableName') known.set(raw(item), { match: matched.from, capture: index + 1 });
            }
            continue;
          }
          if (left.length === right.length) {
            const values = right.map((item): Binding | undefined => {
              const knownValue =
                role(item, known) ??
                strings(item, known, lookup) ??
                capture(item, known) ??
                pathPattern(item, known);
              if (knownValue) return knownValue;
              if (item.name === 'DictionaryExpression') return item;
              const choices = dispatchChoices(item, known);
              if (choices) return { choices };
            });
            for (const [index, item] of left.entries()) {
              if (item.name !== 'VariableName') continue;
              const value = values[index];
              if (value) known.set(raw(item), value);
              else known.set(raw(item), null);
            }
          }
        }
        if (statement.name === 'ReturnStatement') {
          const expression = statement.lastChild;
          if (expression) {
            const choices = dispatchChoices(expression, known);
            if (choices) accept(choices);
            else if (expression.name === 'ConditionalExpression') {
              const parts = children(expression);
              if (parts.length === 5 && parts[4].name === 'None') accept(condition(parts[2], known));
            } else if (!['None', 'return'].includes(expression.name)) {
              for (const clause of current) if (clause.methods?.length && clause.paths?.length) record(clause);
            }
          }
        } else if (statement.name === 'IfStatement') {
          const parts = children(statement);
          for (let i = 0; i < parts.length; i++) {
            if (parts[i].name === 'if' || parts[i].name === 'elif') {
              const test = parts[i + 1],
                branch = parts[i + 2];
              if (!test || branch?.name !== 'Body') continue;
              const end = branch.lastChild;
              const value = end?.name === 'ReturnStatement' ? end.lastChild : undefined;
              const reject =
                (end?.name === 'RaiseStatement' && !branch.getChild('ReturnStatement')) ||
                value?.name === 'None' ||
                (value?.name === 'return' &&
                  (end?.prevSibling?.name === ':' || /\.send_error\(/.test(raw(branch))));
              if (!reject) walk(branch, accept(condition(test, known)), new Map(known));
              else if (parts.length === 3) current = accept(condition(test, known, true), true);
              i += 2;
            } else if (parts[i].name === 'Body') walk(parts[i], current, new Map(known));
          }
        } else if (!['FunctionDefinition', 'ClassDefinition'].includes(statement.name)) {
          for (const nested of statement.getChildren('Body')) walk(nested, current, new Map(known));
        }
      }
    }
    walk(body, [initial], aliases);
  }

  let visited = 0;
  tree.iterate({
    enter({ node, name }) {
      if (++visited % 256 === 0) checkpoint?.();
      if (name !== 'FunctionDefinition') return;
      const parent = node.parent?.parent;
      const bases = parent?.name === 'ClassDefinition' ? parent.getChild('ArgList') : null;
      scanFunction(
        node,
        Boolean(bases && /\b(?:BaseHTTPRequestHandler|SimpleHTTPRequestHandler)\b/.test(raw(bases))),
      );
    },
  });
  const identifiedPaths = new Set([...routes.values()].map((route) => route.definition.path));
  for (const [offset, path] of unresolvedMethods) {
    if (!identifiedPaths.has(path)) unresolved.set(offset, 'HTTP method could not be determined for ' + path);
  }
  for (const [offset, message] of unresolved)
    diagnostics.push({ code: 'HTTP_HANDLER_UNRESOLVED', path: file, line: line(offset), message });
  return [...routes.values()];
}
