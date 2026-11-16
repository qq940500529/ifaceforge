import { parse } from 'uri-template';

export function resourceTemplate(source: string) {
  const template = parse(source);
  const variables = new Map<string, boolean>();
  for (const part of template.ast.parts) {
    if (part.type !== 'expression') continue;
    for (const { name } of part.variables) {
      variables.set(name, variables.get(name) === true || !['?', '&', ';', '#'].includes(part.operator));
    }
  }
  return {
    variables: Array.from(variables, ([name, required]) => ({ name, required })),
    expand(values: Record<string, unknown>) {
      for (const [name, required] of variables) {
        if (required && (!Object.hasOwn(values, name) || values[name] == null || values[name] === '')) {
          throw new Error('Missing URI template variable: ' + name);
        }
      }
      const known = Object.create(null) as Record<string, unknown>;
      for (const name of variables.keys()) {
        if (Object.hasOwn(values, name)) known[name] = values[name];
      }
      return template.expand(known);
    },
  };
}
