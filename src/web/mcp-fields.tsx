import { Alert, AutoComplete, Button, Input, InputNumber, Select, Space, Tag, Typography } from 'antd';
import type { Assertion } from '../app/api.js';
import { Code, Field, JsonField, json, parse, useWorkspace } from './components.js';

export function useMcpText() {
  const { lang } = useWorkspace();
  return (en: string, zh: string) => (lang === 'zh-CN' ? zh : en);
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function argumentMap(text: string) {
  const value = parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

export type Parameter = {
  name: string;
  required: boolean;
  description?: string;
  type?: string;
  values?: unknown[];
  defaultValue?: unknown;
};

export function parameters(item: Record<string, unknown>, type: string): Parameter[] {
  if (type === 'prompt' && Array.isArray(item.arguments)) {
    return item.arguments
      .map(objectValue)
      .filter((entry) => typeof entry.name === 'string')
      .map((entry) => ({
        name: String(entry.name),
        required: entry.required === true,
        type: 'string',
        description: typeof entry.description === 'string' ? entry.description : undefined,
      }));
  }
  const schema = objectValue(item.inputSchema);
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(objectValue(schema.properties)).map(([name, definition]) => {
    const field = objectValue(definition);
    return {
      name,
      required: required.includes(name),
      description: typeof field.description === 'string' ? field.description : undefined,
      type: typeof field.type === 'string' ? field.type : undefined,
      defaultValue: field.default,
      values: Array.isArray(field.enum) ? field.enum : undefined,
    };
  });
}

export function ParameterFields({
  fields,
  value,
  change,
}: {
  fields: Parameter[];
  value: string;
  change: (value: string) => void;
}) {
  const msg = useMcpText();
  let args: Record<string, unknown>;
  try {
    args = argumentMap(value);
  } catch {
    return null;
  }
  const update = (key: string, next: unknown) => {
    const copy = { ...args };
    if (next === undefined) delete copy[key];
    else Object.defineProperty(copy, key, { value: next, enumerable: true, configurable: true });
    change(json(copy));
  };
  const form = fields.filter(
    (field) => field.values || ['string', 'integer', 'number', 'boolean'].includes(field.type ?? ''),
  );
  return form.length ? (
    <div className="mcp-parameters">
      {form.map((field) => {
        const { name, description, type } = field;
        const label = name + (field.required ? ' *' : '');
        const current = args[name];
        const values = field.values ?? (type === 'boolean' ? [true, false] : undefined);
        const index = values?.findIndex((entry) => json(entry) === json(current)) ?? -1;
        return (
          <div key={name} className="mcp-field">
            <Field label={label}>
              {values ? (
                <Select
                  aria-label={label}
                  style={{ width: '100%' }}
                  allowClear
                  virtual={false}
                  value={index < 0 ? undefined : index}
                  onChange={(next) => update(name, next === undefined ? undefined : values[next])}
                  options={values.map((entry, at) => ({
                    value: at,
                    label: String(typeof entry === 'string' ? entry : json(entry)),
                  }))}
                />
              ) : type === 'number' || type === 'integer' ? (
                <InputNumber
                  aria-label={label}
                  style={{ width: '100%' }}
                  precision={type === 'integer' ? 0 : undefined}
                  value={typeof current === 'number' ? current : null}
                  onChange={(next) => update(name, next ?? undefined)}
                />
              ) : (
                <Input
                  aria-label={label}
                  value={typeof current === 'string' ? current : ''}
                  placeholder={
                    current && typeof current === 'object'
                      ? msg('Value set in JSON', '值已在 JSON 中设置')
                      : undefined
                  }
                  onChange={(event) =>
                    update(name, event.target.value === '' && !field.required ? undefined : event.target.value)
                  }
                />
              )}
            </Field>
            {description && <Typography.Text type="secondary">{description}</Typography.Text>}
          </div>
        );
      })}
    </div>
  ) : null;
}

type AssertionKind = 'jsonExists' | 'jsonEquals' | 'textContains' | 'toolError';
export type AssertionDraft = { id: number; type: AssertionKind; pointer: string; value: string };

export function toAssertions(drafts: AssertionDraft[]): Assertion[] {
  return drafts.map(({ type, pointer, value }) => {
    if (type === 'toolError') return { type, equals: value === 'true' };
    if (!/^(?:\/(?:[^~/]|~[01])*)*$/.test(pointer)) throw new Error('Invalid JSON Pointer: ' + pointer);
    if (type === 'jsonExists') return { type, pointer };
    if (type === 'textContains') {
      if (!value) throw new Error('Enter the required text');
      return { type, pointer, text: value };
    }
    return { type, pointer, equals: parse(value) };
  });
}

function resultPaths(result: unknown) {
  const value = objectValue(result).structuredContent ?? result;
  const paths: string[] = [];
  function walk(current: unknown, pointer: string, depth: number) {
    if (paths.length >= 80 || depth > 5 || !current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (paths.length >= 80) return;
      const path = pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
      paths.push(path);
      walk(child, path, depth + 1);
    }
  }
  walk(value, '', 0);
  return paths;
}

export function AssertionsEditor({
  rows,
  change,
  result,
  tool,
}: {
  rows: AssertionDraft[];
  change: (rows: AssertionDraft[]) => void;
  result: unknown;
  tool: boolean;
}) {
  const msg = useMcpText();
  const { t } = useWorkspace();
  const paths = resultPaths(result);
  const options: { label: string; value: AssertionKind }[] = [
    { label: msg('Field exists', '字段存在'), value: 'jsonExists' },
    { label: msg('Field equals', '字段等于'), value: 'jsonEquals' },
    { label: msg('Text contains', '正文包含'), value: 'textContains' },
  ];
  if (tool) options.push({ label: msg('Tool reports an error', '工具返回错误'), value: 'toolError' });
  const update = (id: number, fields: Partial<AssertionDraft>) =>
    change(rows.map((row) => (row.id === id ? { ...row, ...fields } : row)));
  const next = rows.reduce((last, row) => Math.max(last, row.id), 0) + 1;
  return (
    <div className="stack mcp-assertions">
      {rows.map((row) => (
        <div className="mcp-assertion" key={row.id}>
          <Select
            aria-label={msg('Assertion type', '断言类型')}
            value={row.type}
            options={options}
            virtual={false}
            onChange={(type) => update(row.id, { type, value: type === 'toolError' ? 'false' : '' })}
          />
          {row.type !== 'toolError' && (
            <AutoComplete
              aria-label="JSON Pointer"
              placeholder="/contents/0/text"
              options={paths.map((value) => ({ value }))}
              filterOption
              value={row.pointer}
              onChange={(pointer) => update(row.id, { pointer })}
            />
          )}
          {row.type === 'toolError' ? (
            <Select
              aria-label={msg('Expected value', '预期值')}
              value={row.value}
              options={[
                { value: 'false', label: 'false' },
                { value: 'true', label: 'true' },
              ]}
              virtual={false}
              onChange={(value) => update(row.id, { value })}
            />
          ) : (
            row.type !== 'jsonExists' && (
              <Input
                aria-label={msg('Expected value', '预期值')}
                placeholder={
                  row.type === 'jsonEquals' ? msg('Expected JSON', '预期 JSON') : msg('Expected text', '预期文字')
                }
                value={row.value}
                onChange={(event) => update(row.id, { value: event.target.value })}
              />
            )
          )}
          <Button onClick={() => change(rows.filter((entry) => entry.id !== row.id))}>{t('remove')}</Button>
        </div>
      ))}
      <Button
        className="mcp-align-start"
        onClick={() => change([...rows, { id: next, type: 'jsonEquals', pointer: '', value: '' }])}
      >
        {msg('Add assertion', '添加断言')}
      </Button>
    </div>
  );
}

function ContentBlock({ entry, nested = false }: { entry: unknown; nested?: boolean }) {
  const msg = useMcpText();
  const item = objectValue(entry);
  const mime = typeof item.mimeType === 'string' ? item.mimeType : '';
  const data = typeof item.data === 'string' ? item.data : item.blob;
  const safeImage =
    typeof data === 'string' &&
    data.length <= 1024 * 1024 &&
    /^image\/(?:png|jpeg|gif|webp)$/.test(mime) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data);
  if (safeImage)
    return (
      <img
        className="mcp-preview-image"
        alt={msg('MCP response image', 'MCP 响应图片')}
        src={'data:' + mime + ';base64,' + data}
      />
    );
  if (typeof item.text === 'string') {
    let preview: unknown = item.text;
    if (mime.includes('json') && item.text.length <= 200_000) {
      try {
        preview = parse(item.text);
      } catch {
        /* Keep the original text readable. */
      }
    }
    return (
      <Code
        value={
          typeof preview === 'string' ? preview.slice(0, 200_000) + (preview.length > 200_000 ? '…' : '') : preview
        }
      />
    );
  }
  if (item.resource && !nested) return <ContentBlock entry={item.resource} nested />;
  if (typeof data === 'string')
    return (
      <Typography.Text type="secondary">
        {msg('Binary content', '二进制内容')} {mime && <Tag>{mime}</Tag>}
      </Typography.Text>
    );
  return <Code value={json(entry)?.slice(0, 200_000)} />;
}

export function McpResult({ value }: { value: unknown }) {
  const msg = useMcpText();
  const result = objectValue(value);
  const contents = Array.isArray(result.contents)
    ? result.contents
    : Array.isArray(result.content)
      ? result.content
      : [];
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return (
    <div className="stack">
      {result.isError === true && <Alert type="error" title={msg('The tool reported an error', '工具返回错误')} />}
      {result.structuredContent !== undefined && (
        <Code value={json(result.structuredContent)?.slice(0, 200_000)} />
      )}
      {contents.slice(0, 80).map((block, index) => (
        <div key={index} className="stack mcp-content">
          {typeof objectValue(block).uri === 'string' && (
            <Typography.Text type="secondary">{String(objectValue(block).uri)}</Typography.Text>
          )}
          <ContentBlock entry={block} />
        </div>
      ))}
      {messages.slice(0, 80).map((entry, index) => {
        const message = objectValue(entry);
        return (
          <div className="stack mcp-content" key={index}>
            <Space>
              <Tag>{String(message.role ?? msg('Message', '消息'))}</Tag>
            </Space>
            <ContentBlock entry={message.content} />
          </div>
        );
      })}
      {result.structuredContent === undefined && !contents.length && !messages.length && (
        <Code value={json(value)?.slice(0, 200_000)} />
      )}
    </div>
  );
}
