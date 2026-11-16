import { Button, Card, Input, InputNumber, Modal, Select, Space, Tabs, Typography } from 'antd';
import { useState } from 'react';
import type { Assertion } from '../app/api.js';
import type { Case } from '../app/runs.js';
import type { HttpRequest } from '../protocols/http.js';
import type { Discovery } from '../protocols/mcp.js';
import type { Entity } from '../scanner/model.js';
import { command, download } from './client.js';
import { CatalogList, EntityDetail, useCatalog } from './catalog-page.js';
import {
  Code,
  EmptyView,
  ErrorView,
  Field,
  JsonField,
  Label,
  ProfilePicker,
  RunPanel,
  TextButtonList,
  json,
  parse,
  useProfiles,
  useRun,
  useWorkspace,
} from './components.js';

function SaveCase({ open, close, make }: { open: boolean; close: () => void; make: () => Partial<Case> }) {
  const { t, refresh, notify } = useWorkspace();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await command('case put', { body: { ...make(), schemaVersion: 1, id, name } });
      refresh();
      notify(t('success'));
      close();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      title={t('saveCase')}
      okText={t('save')}
      onOk={() => void save()}
      onCancel={close}
      confirmLoading={busy}
      destroyOnHidden
    >
      <div className="stack">
        <ErrorView error={error} />
        <Field label={t('caseId')}>
          <Input value={id} onChange={(event) => setId(event.target.value)} />
        </Field>
        <Field label={t('caseName')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function ApiPage() {
  const { t, refresh, notify } = useWorkspace();
  const list = useCatalog('api');
  const profiles = useProfiles();
  const action = useRun();
  const [profile, setProfile] = useState<string>();
  const [method, setMethod] = useState('GET');
  const [target, setTarget] = useState('');
  const [targetPreview, setTargetPreview] = useState<{ method: string; url: string }>();
  const [operationId, setOperation] = useState<string>();
  const [query, setQuery] = useState('[]');
  const [headers, setHeaders] = useState('[]');
  const [body, setBody] = useState('');
  const [inputs, setInputs] = useState('{}');
  const [timeout, setTimeout] = useState<number>();
  const [assertions, setAssertions] = useState('[]');
  const [error, setError] = useState<unknown>();
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importType, setImportType] = useState<'file' | 'url'>('file');
  const [importPath, setImportPath] = useState('');
  const [service, setService] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const request = (): HttpRequest => ({
    method,
    ...(target.startsWith('/') ? { path: target } : { url: target }),
    operationId,
    query: parse(query) as HttpRequest['query'],
    headers: parse(headers) as HttpRequest['headers'],
    body: body.trim() ? (parse(body) as HttpRequest['body']) : undefined,
    inputs: parse(inputs) as HttpRequest['inputs'],
    timeoutMs: timeout,
  });
  function update(draft: HttpRequest) {
    setMethod(draft.method);
    setTarget(draft.url ?? draft.path ?? '');
    setOperation(draft.operationId);
    setInputs(json(draft.inputs ?? {}));
    setQuery(json(draft.query ?? []));
    setHeaders(json(draft.headers ?? []));
    setBody(draft.body ? json(draft.body) : '');
    setTimeout(draft.timeoutMs);
  }
  async function safely(operation: () => Promise<void>) {
    setError(undefined);
    try {
      await operation();
    } catch (error) {
      setError(error);
    }
  }
  function choose(entity: Entity) {
    void safely(async () => update(await command<HttpRequest>('api draft', { id: entity.id })));
  }
  return (
    <div className="split">
      <div className="stack">
        <div className="toolbar">
          <Button
            onClick={() => {
              list.setSelected('');
              update({ method: 'GET' });
            }}
          >
            {t('manual')}
          </Button>
          <Button onClick={() => setImporting(true)}>{t('importApi')}</Button>
        </div>
        <CatalogList list={list} choose={choose} />
        {list.detail.data && <EntityDetail entity={list.detail.data} />}
        {list.selected && (
          <Space wrap>
            {['json', 'yaml'].map((format) => (
              <Button
                key={format}
                onClick={() =>
                  void safely(async () => {
                    const data = await command<{ text: string }>('api export', { id: list.selected, format });
                    download('openapi.' + format, data.text);
                  })
                }
              >
                {t(format === 'json' ? 'export' : 'exportYaml')}
              </Button>
            ))}
          </Space>
        )}
      </div>
      <div className="stack">
        <ErrorView error={error} />
        <Card size="small" title={t('request')}>
          <div className="stack">
            <div className="toolbar">
              <Select
                aria-label={t('method')}
                value={method}
                onChange={setMethod}
                options={['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'].map((value) => ({
                  value,
                  label: value,
                }))}
              />
              <Input
                aria-label={t('target')}
                className="grow"
                placeholder={t('target')}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
              <ProfilePicker profiles={profiles.data?.items ?? []} value={profile} change={setProfile} />
            </div>
            <div className="split split-even">
              <JsonField label={t('query')} value={query} change={setQuery} rows={3} />
              <JsonField label={t('header')} value={headers} change={setHeaders} rows={3} />
              <JsonField label={t('inputs')} value={inputs} change={setInputs} rows={3} />
              <JsonField label={t('body')} value={body} change={setBody} rows={3} />
            </div>
            <JsonField label={t('assertions')} value={assertions} change={setAssertions} rows={3} />
            <Field label={t('timeout')}>
              <InputNumber
                min={1}
                max={300000}
                value={timeout}
                onChange={(value) => setTimeout(value ?? undefined)}
              />
            </Field>
            <Space wrap>
              <Button
                type="primary"
                loading={action.pending}
                onClick={() =>
                  void action.start(() =>
                    command('api send', {
                      body: request(),
                      profile,
                      assertions: parse(assertions) as Assertion[],
                    }),
                  )
                }
              >
                {t('send')}
              </Button>
              <Button
                onClick={() =>
                  void safely(async () => {
                    setTargetPreview(await command('api preview', { body: request(), profile }));
                  })
                }
              >
                {t('previewTarget')}
              </Button>
              <Button
                onClick={() =>
                  void safely(async () => {
                    const data = await command<{ curl: string }>('api curl', { body: request(), profile });
                    await navigator.clipboard.writeText(data.curl);
                    notify(t('copied'));
                  })
                }
              >
                {t('curl')}
              </Button>
              <Button onClick={() => setSaving(true)}>{t('saveCase')}</Button>
            </Space>
            {targetPreview && <Code value={targetPreview.method + ' ' + targetPreview.url} />}
          </div>
        </Card>
        <Card size="small" title={t('response')}>
          <RunPanel action={action} />
        </Card>
      </div>
      {saving && (
        <SaveCase
          open
          close={() => setSaving(false)}
          make={() => ({
            kind: 'http',
            profile,
            request: request(),
            assertions: parse(assertions) as Assertion[],
          })}
        />
      )}
      <Modal
        open={importing}
        title={t('importApi')}
        okText={t('import')}
        onCancel={() => setImporting(false)}
        confirmLoading={importBusy}
        onOk={() => {
          setImportBusy(true);
          void safely(async () => {
            await command('api import', { [importType]: importPath, profile, service: service || undefined });
            refresh();
            setImporting(false);
          }).finally(() => setImportBusy(false));
        }}
      >
        <div className="stack">
          <ErrorView error={error} />
          <Select
            value={importType}
            onChange={setImportType}
            options={[
              { value: 'file', label: t('file') },
              { value: 'url', label: t('url') },
            ]}
          />
          <Field label={t(importType)}>
            <Input value={importPath} onChange={(event) => setImportPath(event.target.value)} />
          </Field>
          <Field label={t('service')}>
            <Input value={service} onChange={(event) => setService(event.target.value)} />
          </Field>
          <ProfilePicker profiles={profiles.data?.items ?? []} value={profile} change={setProfile} />
        </div>
      </Modal>
    </div>
  );
}

export function McpPage() {
  const { t, refresh } = useWorkspace();
  const profiles = useProfiles();
  const action = useRun();
  const list = useCatalog('mcp');
  const [profile, setProfile] = useState<string>();
  const [connection, setConnection] = useState<{ id: string; protocolVersion?: string }>();
  const [inventoryId, setInventoryId] = useState('');
  const [inventory, setInventory] = useState<Discovery>();
  const [argument, setArgument] = useState('{}');
  const [uri, setUri] = useState('');
  const [selected, setSelected] = useState<{ type: string; name: string; details: Record<string, unknown> }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saving, setSaving] = useState(false);
  const chosen = profiles.data?.items.find((item) => item.id === profile);
  const discovered =
    action.run?.subject === 'discover' ? (action.run.steps[0]?.result as Discovery | undefined) : undefined;
  const effective = discovered ?? inventory;
  if (discovered && action.run!.id !== inventoryId) {
    setInventoryId(action.run!.id);
    setInventory(discovered);
  }
  async function connect() {
    setBusy(true);
    setError(undefined);
    try {
      setConnection(await command('mcp connect', { profile }));
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError(undefined);
    try {
      await command('mcp disconnect', { id: connection?.id });
      setConnection(undefined);
      setInventory(undefined);
      setSelected(undefined);
      action.setRun(undefined);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  const execute = (name: string, id?: string) =>
    void action.start(() =>
      command(name, {
        id,
        profile,
        connection: connection?.id,
        args: name === 'mcp call' || name === 'mcp prompt' ? parse(argument) : undefined,
      }),
    );
  return (
    <div className="split">
      <div className="stack">
        <Card size="small" title={t('connections')}>
          <div className="stack">
            <ErrorView error={error} />
            <ProfilePicker
              profiles={(profiles.data?.items ?? []).filter((item) => item.mcp)}
              value={profile}
              change={(value) => {
                if (!connection) setProfile(value);
              }}
            />
            {chosen?.mcp && <Code value={chosen.mcp} />}
            <Space wrap>
              {connection ? (
                <>
                  <Label value="connected" />
                  {connection.protocolVersion}
                  <Button onClick={() => void disconnect()} loading={busy}>
                    {t('disconnect')}
                  </Button>
                  <Button
                    type="primary"
                    loading={action.pending}
                    onClick={() => {
                      execute('mcp discover');
                      refresh();
                    }}
                  >
                    {t('discover')}
                  </Button>
                </>
              ) : (
                <Button type="primary" disabled={!chosen} loading={busy} onClick={() => void connect()}>
                  {t('connect')}
                </Button>
              )}
            </Space>
          </div>
        </Card>
        <CatalogList list={list} />
        {list.detail.data && <EntityDetail entity={list.detail.data} />}
      </div>
      <div className="stack">
        <Card size="small" title={t('definition')}>
          {effective ? (
            <Tabs
              items={effective.groups.map((group) => ({
                key: group.type,
                label: t(group.type),
                children: (
                  <div className="stack">
                    <Label value={group.state} />
                    {group.error !== undefined && <Code value={group.error} />}
                    <TextButtonList
                      items={group.items}
                      id={(item) => String(item.name ?? item.uri ?? item.uriTemplate)}
                      name={(item) => String(item.name ?? item.uri ?? item.uriTemplate)}
                      choose={(item) => {
                        const name = String(item.name ?? item.uri ?? item.uriTemplate);
                        setSelected({ type: group.type, name, details: item });
                        setUri(String(item.uri ?? item.uriTemplate ?? ''));
                        const schema = item.inputSchema as
                          { properties?: Record<string, { default?: unknown }> } | undefined;
                        const argumentsDraft = Object.fromEntries(
                          Object.entries(schema?.properties ?? {})
                            .filter(([, prop]) => prop?.default !== undefined)
                            .map(([key, prop]) => [key, prop.default]),
                        );
                        setArgument(json(argumentsDraft));
                      }}
                    />
                  </div>
                ),
              }))}
            />
          ) : (
            <Typography.Text type="secondary">{t('noConnection')}</Typography.Text>
          )}
        </Card>
        {selected && (
          <Card size="small" title={selected.name}>
            <div className="stack">
              <Code value={selected.details} />
              {selected.type === 'tool' && (
                <ToolFields schema={selected.details.inputSchema} value={argument} change={setArgument} />
              )}
              {['tool', 'prompt'].includes(selected.type) ? (
                <JsonField label={t('argument')} value={argument} change={setArgument} />
              ) : (
                <Field label={t('uri')}>
                  <Input value={uri} onChange={(event) => setUri(event.target.value)} />
                </Field>
              )}
              <Space wrap>
                {selected.type === 'tool' ? (
                  <>
                    <Button
                      type="primary"
                      disabled={!connection}
                      loading={action.pending}
                      onClick={() => execute('mcp call', selected.name)}
                    >
                      {t('call')}
                    </Button>
                    <Button onClick={() => setSaving(true)}>{t('saveCase')}</Button>
                  </>
                ) : selected.type === 'prompt' ? (
                  <Button
                    type="primary"
                    disabled={!connection}
                    loading={action.pending}
                    onClick={() => execute('mcp prompt', selected.name)}
                  >
                    {t('getPrompt')}
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    disabled={!connection}
                    loading={action.pending}
                    onClick={() => execute('mcp read', uri)}
                  >
                    {t('read')}
                  </Button>
                )}
              </Space>
            </div>
          </Card>
        )}
        <Card size="small" title={t('response')}>
          {connection || action.run ? <RunPanel action={action} /> : <EmptyView select />}
        </Card>
      </div>
      {saving && selected && (
        <SaveCase
          open
          close={() => setSaving(false)}
          make={() => ({
            kind: 'mcp',
            profile,
            request: { tool: selected.name, arguments: parse(argument) as Record<string, unknown> },
            assertions: [{ type: 'toolError', equals: false }],
          })}
        />
      )}
    </div>
  );
}

type ToolProperty = { type?: string; enum?: unknown[] };

function ToolFields({
  schema,
  value,
  change,
}: {
  schema: unknown;
  value: string;
  change: (value: string) => void;
}) {
  const shape = schema as { properties?: Record<string, ToolProperty>; required?: string[] } | undefined;
  let current: Record<string, unknown>;
  try {
    const parsed = parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    current = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const props = Object.entries(shape?.properties ?? {}).filter(
    ([, prop]) => ['string', 'number', 'integer', 'boolean'].includes(prop?.type ?? '') && !prop.enum,
  );
  if (!props.length) return null;
  const update = (key: string, field: unknown) => {
    const args = { ...current };
    if (field === undefined) delete args[key];
    else args[key] = field;
    change(json(args));
  };
  return (
    <div className="split split-even">
      {props.map(([key, prop]) => {
        const label = key + (shape?.required?.includes(key) ? ' *' : '');
        return (
          <Field key={key} label={label}>
            {prop.type === 'boolean' ? (
              <Select<string | undefined>
                aria-label={label}
                allowClear
                value={typeof current[key] === 'boolean' ? String(current[key]) : undefined}
                onChange={(field) => update(key, field === undefined ? undefined : field === 'true')}
                options={[
                  { value: 'true', label: 'true' },
                  { value: 'false', label: 'false' },
                ]}
              />
            ) : prop.type === 'string' ? (
              <Input
                aria-label={label}
                value={typeof current[key] === 'string' ? (current[key] as string) : ''}
                onChange={(event) => update(key, event.target.value)}
              />
            ) : (
              <InputNumber
                aria-label={label}
                precision={prop.type === 'integer' ? 0 : undefined}
                value={typeof current[key] === 'number' ? (current[key] as number) : null}
                onChange={(field) => update(key, field ?? undefined)}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
