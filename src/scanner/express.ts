import traverse, { type NodePath } from '@babel/traverse';
import { parseJavaScript } from './javascript.js';
import { apiId, type Diagnostic, type Observation } from './model.js';

const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
type Target = { kind: 'factory' | 'routerFactory' | 'server' | 'client' } | { kind: 'route'; route: string };

function property(path: NodePath) {
  if (!path.isMemberExpression()) return undefined;
  if (!path.node.computed && path.node.property.type === 'Identifier') return path.node.property.name;
  return path.node.property.type === 'StringLiteral' ? path.node.property.value : undefined;
}

function literal(path: NodePath | undefined, depth = 0): string | undefined {
  if (!path || depth > 10) return;
  if (path.isStringLiteral()) return path.node.value;
  if (path.isTemplateLiteral() && !path.node.expressions.length)
    return path.node.quasis[0]?.value.cooked ?? undefined;
  if (path.isTSAsExpression() || path.isTSSatisfiesExpression()) return literal(path.get('expression'), depth + 1);
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (binding?.constant && binding.path.isVariableDeclarator()) {
      const init = binding.path.get('init');
      if (init.node) return literal(init, depth + 1);
    }
  }
}

function packageTarget(name: string | undefined, imported?: string): Target | undefined {
  if (name === 'express') {
    if (imported === 'Router') return { kind: 'routerFactory' };
    if (!imported || imported === 'default') return { kind: 'factory' };
  }
  if (name === 'axios' && (!imported || imported === 'default')) return { kind: 'client' };
}

function target(path: NodePath, depth = 0): Target | undefined {
  if (depth > 12) return;
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (!binding?.constant) return;
    const origin = binding.path;
    if (origin.isImportDefaultSpecifier() || origin.isImportNamespaceSpecifier() || origin.isImportSpecifier()) {
      if (!origin.parentPath.isImportDeclaration()) return;
      const imported = origin.isImportSpecifier() ? origin.node.imported : undefined;
      return packageTarget(
        origin.parentPath.node.source.value,
        imported?.type === 'Identifier' ? imported.name : imported?.value,
      );
    }
    if (origin.isVariableDeclarator()) {
      const init = origin.get('init');
      if (!init.node) return;
      if (origin.get('id').isIdentifier()) return target(init, depth + 1);
      if (origin.get('id').isObjectPattern() && target(init, depth + 1)?.kind === 'factory') {
        const { id } = origin.node;
        if (
          id.type === 'ObjectPattern' &&
          id.properties.some(
            (item) =>
              item.type === 'ObjectProperty' &&
              item.key.type === 'Identifier' &&
              item.key.name === 'Router' &&
              item.value.type === 'Identifier' &&
              item.value.name === path.node.name,
          )
        )
          return { kind: 'routerFactory' };
      }
    }
    return;
  }
  if (path.isTSAsExpression() || path.isTSSatisfiesExpression()) return target(path.get('expression'), depth + 1);
  if (path.isMemberExpression()) {
    const kind = target(path.get('object'), depth + 1)?.kind;
    if (kind === 'factory' && property(path) === 'Router') return { kind: 'routerFactory' };
    if (kind === 'factory' && property(path) === 'default') return { kind };
  }
  if (path.isCallExpression()) {
    const callee = path.get('callee');
    const args = path.get('arguments');
    if (callee.isIdentifier({ name: 'require' }) && !callee.scope.hasBinding('require'))
      return packageTarget(literal(args[0]));
    const factory = target(callee, depth + 1)?.kind;
    if (factory === 'factory' || factory === 'routerFactory') return { kind: 'server' };
    if (callee.isIdentifier() && /^(?:create|make)(?:[A-Z]\w*)?(?:Api|Client)$/.test(callee.node.name))
      return { kind: 'client' };
    if (callee.isMemberExpression()) {
      const receiver = target(callee.get('object'), depth + 1)?.kind;
      const method = property(callee);
      if (receiver === 'client' && method === 'create') return { kind: 'client' };
      if (receiver === 'server' && method === 'route') {
        const route = literal(args[0]);
        if (route) return { kind: 'route', route };
      }
    }
  }
}

export function scanExpressSource(
  path: string,
  text: string,
  service: string,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
) {
  if (!/\b(?:express|axios|fetch|(?:create|make)\w*(?:Api|Client))\b/.test(text)) return [];
  let ast;
  try {
    ast = parseJavaScript(path, text);
  } catch (error) {
    if (/["']express["']/.test(text))
      diagnostics.push({ path, code: 'EXPRESS_SOURCE_PARSE', message: (error as Error).message });
    return [];
  }
  const observations: Observation[] = [];
  let visits = 0;
  traverse(ast, {
    enter() {
      if (++visits % 256 === 0) checkpoint?.();
    },
    CallExpression(call) {
      const callee = call.get('callee');
      const args = call.get('arguments');
      let method = property(callee);
      let value: string | undefined;
      let origin: 'source' | 'call-site';
      if (callee.isIdentifier({ name: 'fetch' }) && !callee.scope.hasBinding('fetch')) {
        const options = args[1];
        if (options && !options.isObjectExpression()) return;
        const methodOption = options
          ?.get('properties')
          .find(
            (item) =>
              item.isObjectProperty() &&
              (item.get('key').isIdentifier({ name: 'method' }) ||
                item.get('key').isStringLiteral({ value: 'method' })),
          );
        const raw = methodOption?.isObjectProperty() ? literal(methodOption.get('value')) : 'GET';
        method = raw?.toLowerCase();
        value = literal(args[0]);
        origin = 'call-site';
      } else {
        if (!callee.isMemberExpression() || !method || !methods.has(method)) return;
        const receiver = target(callee.get('object'));
        if (!receiver || !['server', 'route', 'client'].includes(receiver.kind)) return;
        origin = receiver.kind === 'client' ? 'call-site' : 'source';
        if (receiver.kind === 'server' && args.length < 2) return;
        value = receiver.kind === 'route' ? receiver.route : literal(args[0]);
      }
      if (!method || !methods.has(method)) return;
      const line = call.node.loc?.start.line;
      if (value === undefined) {
        if (origin === 'source')
          diagnostics.push({
            path,
            line,
            code: 'DYNAMIC_ROUTE',
            message: 'Express registration has a non-literal path',
          });
        return;
      }
      if (!value.startsWith('/') || value.startsWith('//')) return;
      const route = origin === 'source' ? value.replace(/:([\w]+)/g, '{$1}') : value.split(/[?#]/, 1)[0];
      const name = method.toUpperCase() + ' ' + route;
      if (origin === 'call-site')
        diagnostics.push({
          path,
          line,
          severity: 'info',
          code: 'HTTP_CALL_SITE',
          message: name + ' is a client call site',
        });
      observations.push({
        id: apiId(service, method, route),
        kind: 'api',
        service,
        name,
        summary: '',
        origin,
        path,
        line,
        definition: { method, path: route, adapter: origin === 'source' ? 'express' : 'http-client' },
      });
    },
  });
  return observations;
}
