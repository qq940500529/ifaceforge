const unsupported = Symbol('unsupported route pattern');
const limit = 32;
type Alternative = { text: string; groups: Record<number, string | true> };
export type PythonRouteTemplate = { path: string; groups: Record<number, string | true>; groupCount: number };

/** Project a bounded subset of Python regex syntax onto HTTP path templates. */
export function projectPythonPattern(pattern: string): PythonRouteTemplate[] | undefined {
  if (pattern.length > 2048) return;
  const text = pattern.replace(/^\^|(?<!\\)\$$/g, '');
  if (!text.startsWith('/')) return;
  let index = 0;
  let parameters = 0;
  let groupCount = 0;
  const parameter = () => '{param' + ++parameters + '}';
  const part = (text: string): Alternative => ({ text, groups: {} });

  function group(depth: number): Alternative[] {
    if (depth > 12) throw unsupported;
    let choices: Alternative[] = [];
    let sequence = [part('')];
    while (index < text.length && text[index] !== ')') {
      if (text[index] === '|') {
        choices = [...choices, ...sequence];
        sequence = [part('')];
        index++;
        if (choices.length >= limit) throw unsupported;
        continue;
      }
      let options = atom(depth);
      const repetition = /^(?:[?+*]|\{\d+(?:,\d*)?\})/.exec(text.slice(index))?.[0];
      if (repetition) {
        index += repetition.length;
        if (repetition === '?') options = [part(''), ...options];
        else if (options.length !== 1 || !/^\{\w+\}$/.test(options[0].text)) throw unsupported;
        if (text[index] === '?') index++;
      }
      if (sequence.length * options.length + choices.length > limit) throw unsupported;
      sequence = sequence.flatMap((prefix) =>
        options.map((value) => ({
          text: prefix.text + value.text,
          groups: { ...prefix.groups, ...value.groups },
        })),
      );
    }
    return [...choices, ...sequence];
  }

  function atom(depth: number): Alternative[] {
    const token = text[index++];
    if (token === '(') {
      const prefix = /^(?:\?:|\?P<([A-Za-z_]\w*)>)/.exec(text.slice(index));
      if (text[index] === '?' && !prefix) throw unsupported;
      if (prefix) index += prefix[0].length;
      const capture = prefix?.[0] === '?:' ? undefined : ++groupCount;
      const values = group(depth + 1);
      if (text[index++] !== ')') throw unsupported;
      const replace = values.every((value) => !value.text.includes('/') && value.text.includes('{'))
        ? prefix?.[1]
          ? '{' + prefix[1] + '}'
          : parameter()
        : undefined;
      return values.map((value) => ({
        text: replace ?? value.text,
        groups:
          capture === undefined
            ? value.groups
            : {
                ...value.groups,
                [capture]: value.text.includes('{') ? true : value.text,
              },
      }));
    }
    if (token === '[') {
      const start = index;
      if (text[index] === '^') index++;
      if (text[index] === ']') index++;
      while (index < text.length && text[index] !== ']') index += text[index] === '\\' ? 2 : 1;
      if (text[index++] !== ']' || index - start < 2) throw unsupported;
      const members = text.slice(start, index - 1);
      if (members.startsWith('^') !== members.includes('/') || /\\[DWS]/.test(members)) throw unsupported;
      return [part(parameter())];
    }
    if (token === '\\') {
      const escaped = text[index++];
      if (escaped && /^[dw]$/.test(escaped)) return [part(parameter())];
      if (escaped && /^[.\-_/~%:+]$/.test(escaped)) return [part(escaped)];
      throw unsupported;
    }
    if (token === '.' && (text[index] === '*' || text[index] === '+')) {
      const suffix = text.slice(index + 1);
      if (!/^[?)]*$/.test(suffix)) throw unsupported;
      return [part(parameter())];
    }
    if (/^[\p{L}\p{N}/_~%:@=-]$/u.test(token)) return [part(token)];
    throw unsupported;
  }

  try {
    const alternatives = group(0);
    if (index !== text.length || alternatives.some(({ text }) => !text.startsWith('/') || text.includes('//')))
      return;
    return alternatives.map(({ text, groups }) => {
      let next = 0;
      const path = text
        .split('/')
        .map((segment) => {
          const dynamic = segment.match(/\{[^{}]+\}/g) ?? [];
          if (dynamic.length > 1) return '{param' + ++next + '}';
          return segment.replace(/\{param\d+\}/g, () => '{param' + ++next + '}');
        })
        .join('/');
      return { path, groups, groupCount };
    });
  } catch (error) {
    if (error !== unsupported) throw error;
  }
}

export function pythonRouteTemplates(pattern: string) {
  const projected = projectPythonPattern(pattern);
  return projected && [...new Set(projected.map((entry) => entry.path))];
}
