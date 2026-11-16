import { Alert, Button, Card, Input, Pagination, Space, Tabs, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { Run } from '../app/runs.js';
import type { Discovery, McpAction } from '../protocols/mcp.js';
import { resourceTemplate } from '../protocols/mcp-template.js';
import { CatalogList, EntityDetail, useCatalog } from './catalog-page.js';
import { SaveCase } from './debug-pages.js';
import {
  Code,
  EmptyView,
  ErrorView,
  Field,
  JsonField,
  Label,
  Loading,
  ProfilePicker,
  RunView,
  TextButtonList,
  json,
  useLoad,
  useProfiles,
  useRun,
  useWorkspace,
  type Listed,
} from './components.js';
import {
  argumentMap,
  AssertionsEditor,
  McpResult,
  objectValue,
  ParameterFields,
  parameters,
  toAssertions,
  useMcpText,
  type AssertionDraft,
  type Parameter,
} from './mcp-fields.js';

const kinds = ['tool', 'resource', 'template', 'prompt'] as const;
type Kind = (typeof kinds)[number];
type Connection = Omit<Discovery, 'groups'> & { id: string };
type Draft = { arguments: string; checks: AssertionDraft[] };
type Entry = Record<string, unknown>;

function itemId(entry: Entry, kind: Kind) {
  return String(kind === 'resource' ? entry.uri : kind === 'template' ? entry.uriTemplate : entry.name);
}

function title(entry: Entry, kind: Kind) {
  return String(entry.title ?? entry.name ?? itemId(entry, kind));
}

function metadataFields(item: Entry, kind: Kind): Parameter[] {
  if (kind !== 'template') return parameters(item, kind);
  try {
    return resourceTemplate(String(item.uriTemplate)).variables.map((field) => ({ ...field, type: 'string' }));
  } catch {
    return [];
  }
}

function defaultDraft(item: Entry, kind: Kind): Draft {
  return {
    arguments: json(
      Object.fromEntries(
        metadataFields(item, kind)
          .filter((field) => field.defaultValue !== undefined)
          .map((field) => [field.name, field.defaultValue]),
      ),
    ),
    checks: kind === 'tool' ? [{ id: 1, type: 'toolError', pointer: '', value: 'false' }] : [],
  };
}

function target(item: Entry, kind: Kind, argument: string): McpAction {
  const id = itemId(item, kind);
  if (kind === 'resource') return { type: 'read', uri: id };
  const args = argumentMap(argument);
  if (kind === 'tool') return { type: 'call', tool: id, arguments: args };
  if (kind === 'template') {
    resourceTemplate(id).expand(args);
    return { type: 'template', uriTemplate: id, arguments: args };
  }
  return { type: 'prompt', name: id, arguments: args as Record<string, string> };
}

function related(run: Run, entry: Entry, kind: Kind) {
  const request = objectValue(run.steps[0]?.request);
  const id = itemId(entry, kind);
  return kind === 'tool'
    ? request.type === 'call' && request.tool === id
    : kind === 'resource'
      ? request.type === 'read' && request.uri === id
      : kind === 'template'
        ? request.type === 'template' && request.uriTemplate === id
        : request.type === 'prompt' && request.name === id;
}

function EntryDetails({ entry, kind }: { entry: Entry; kind: Kind }) {
  const { t } = useWorkspace();
  const msg = useMcpText();
  const fields = metadataFields(entry, kind);
  const annotations = objectValue(entry.annotations);
  const hints = [
    ['readOnlyHint', msg('Read-only', '只读')],
    ['destructiveHint', msg('May change data', '可能修改数据')],
    ['idempotentHint', msg('Idempotent', '幂等')],
    ['openWorldHint', msg('External interaction', '访问外部系统')],
  ].filter(([key]) => annotations[key] === true);
  return (
    <div className="stack">
      <Typography.Paragraph>
        {String(entry.description ?? '') || msg('No description provided.', '服务未填写说明。')}
      </Typography.Paragraph>
      {kind === 'resource' || kind === 'template' ? <Code value={itemId(entry, kind)} /> : null}
      {typeof entry.mimeType === 'string' && (
        <Space wrap>
          <Tag>{entry.mimeType}</Tag>
        </Space>
      )}
      {!!hints.length && (
        <Space wrap>
          {hints.map(([key, label]) => (
            <Tag key={key}>{label}</Tag>
          ))}
        </Space>
      )}
      {!!fields.length && (
        <dl className="mcp-definition">
          {fields.map((field) => (
            <div className="mcp-definition-row" key={field.name}>
              <dt>
                {field.name} {field.required && <Tag>{msg('Required', '必填')}</Tag>}
              </dt>
              <dd>
                {field.type && <Tag>{field.type}</Tag>}
                {field.description || ''}
                {field.defaultValue !== undefined && <Code value={field.defaultValue} />}
                {field.values && <Code value={field.values} />}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {entry.inputSchema !== undefined && (
        <details>
          <summary>{msg('Input schema', '输入 Schema')}</summary>
          <Code value={entry.inputSchema} />
        </details>
      )}
      {entry.outputSchema !== undefined && (
        <details>
          <summary>{msg('Output schema', '输出 Schema')}</summary>
          <Code value={entry.outputSchema} />
        </details>
      )}
      <details>
        <summary>{msg('Raw definition', '原始定义')}</summary>
        <Code value={entry} />
      </details>
      <Typography.Text type="secondary">{t(kind)}</Typography.Text>
    </div>
  );
}

function ScannedMcp() {
  const msg = useMcpText();
  const list = useCatalog('mcp');
  return (
    <details>
      <summary>{msg('Project scan records', '项目扫描记录')}</summary>
      <div className="stack">
        <CatalogList list={list} />
        {list.detail.data && <EntityDetail entity={list.detail.data} />}
      </div>
    </details>
  );
}

export function McpPage() {
  const { t, command, revision } = useWorkspace();
  const msg = useMcpText();
  const profiles = useProfiles();
  const discovery = useRun();
  const execution = useRun();
  const [profile, setProfile] = useState<string>();
  const [connection, setConnection] = useState<Connection>();
  const [inventory, setInventory] = useState<{ data: Discovery; when: string }>();
  const [phase, setPhase] = useState<'connecting' | 'disconnecting'>();
  const [error, setError] = useState<unknown>();
  const [kind, setKind] = useState<Kind>('tool');
  const [id, setId] = useState<string>();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [panel, setPanel] = useState('test');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [activeKey, setActiveKey] = useState<string>();
  const [results, setResults] = useState<Record<string, Run>>({});
  const [historyId, setHistoryId] = useState<string>();
  const [save, setSave] = useState<{
    request: McpAction;
    assertions: ReturnType<typeof toAssertions>;
    profile: string;
  }>();
  const selectedProfile = profiles.data?.items.find((item) => item.id === profile);
  const history = useLoad(
    () =>
      profile
        ? command<Listed<Run>>('run list', { kind: 'mcp', profile, limit: 100 })
        : Promise.resolve(undefined),
    [profile, revision],
  );
  const definition = inventory?.data ?? connection;
  const group = inventory?.data.groups.find((entry) => entry.type === kind);
  const entry = group?.items.find((entry) => itemId(entry, kind) === id);
  const key = kind + ':' + (entry ? itemId(entry, kind) : '');
  const draft = entry ? (drafts[key] ?? defaultDraft(entry, kind)) : undefined;
  const last = activeKey === key ? (execution.run ?? results[key]) : results[key];
  const relevant = (history.data?.items ?? []).filter(
    (run) => run.profile === profile && run.subject !== 'discover' && (!entry || related(run, entry, kind)),
  );
  const previous = relevant.find((run) => run.id === historyId);
  const term = query.trim().normalize('NFKC').toLowerCase();
  const filtered = (group?.items ?? []).filter((item) =>
    [itemId(item, kind), item.name, item.title, item.description].some((text) =>
      String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .includes(term),
    ),
  );
  const pageSize = 12;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const work = discovery.pending || execution.pending;
  const server = definition?.server;

  useEffect(() => {
    const run = discovery.run;
    const result = run?.steps[0]?.result as Discovery | undefined;
    if (run?.status === 'passed' && result?.groups)
      setInventory({ data: result, when: run.finished ?? run.started });
  }, [discovery.run]);

  useEffect(() => {
    const run = execution.run;
    if (activeKey && run && run.status !== 'running') setResults((all) => ({ ...all, [activeKey]: run }));
  }, [activeKey, execution.run]);

  function refreshDirectory(selected: Connection, profile: string) {
    setError(undefined);
    discovery.setRun(undefined);
    return discovery.start(() => command('mcp discover', { profile, connection: selected.id }));
  }

  async function connect() {
    if (!profile) return;
    setPhase('connecting');
    setError(undefined);
    try {
      const value = await command<Connection>('mcp connect', { profile });
      setConnection(value);
      await refreshDirectory(value, profile);
    } catch (error) {
      setError(error);
    } finally {
      setPhase(undefined);
    }
  }

  async function disconnect() {
    if (!connection) return;
    setPhase('disconnecting');
    setError(undefined);
    try {
      await command('mcp disconnect', { id: connection.id });
      setConnection(undefined);
      setInventory(undefined);
      discovery.setRun(undefined);
      execution.setRun(undefined);
      setActiveKey(undefined);
      setId(undefined);
      setDrafts({});
      setResults({});
      setHistoryId(undefined);
    } catch (error) {
      setError(error);
    } finally {
      setPhase(undefined);
    }
  }

  function switchKind(next: Kind) {
    setKind(next);
    setId(undefined);
    setQuery('');
    setPage(1);
    setHistoryId(undefined);
  }

  function choose(next: Entry) {
    setId(itemId(next, kind));
    setPanel('test');
    setHistoryId(undefined);
    setError(undefined);
  }

  function changeDraft(update: Partial<Draft>) {
    if (!draft) return;
    setDrafts((current) => ({ ...current, [key]: { ...draft, ...update } }));
  }

  function test(keep: boolean) {
    if (!entry || !draft || !profile) return;
    setError(undefined);
    try {
      const request = target(entry, kind, draft.arguments);
      const assertions = toAssertions(draft.checks);
      if (keep) {
        setSave({ request, assertions, profile });
        return;
      }
      if (!connection || work) return;
      execution.setRun(undefined);
      setActiveKey(key);
      void execution.start(() =>
        command('mcp batch', {
          body: { schemaVersion: 1, steps: [{ ...request, id: request.type, assertions }] },
          profile,
          connection: connection.id,
        }),
      );
    } catch (error) {
      setError(error);
    }
  }

  let expanded: string | undefined;
  if (entry && draft && kind === 'template') {
    try {
      expanded = resourceTemplate(itemId(entry, kind)).expand(argumentMap(draft.arguments));
    } catch {
      /* Wait for valid input. */
    }
  }

  return (
    <div className="stack mcp-workbench">
      <Card size="small" className="mcp-connection">
        <div className="mcp-service-header">
          <div className="mcp-service-title">
            {server ? (
              <Typography.Title level={4}>{server.name}</Typography.Title>
            ) : (
              <Typography.Text strong>{t('connections')}</Typography.Text>
            )}
            <Space wrap size={[5, 5]}>
              <Label value={connection ? 'connected' : 'disconnected'} />
              {selectedProfile?.mcp && (
                <Tag>{selectedProfile.mcp.transport === 'stdio' ? 'stdio' : 'Streamable HTTP'}</Tag>
              )}
              {connection?.protocolVersion && <Tag>{connection.protocolVersion}</Tag>}
              {server?.version && <Typography.Text type="secondary">{server.version}</Typography.Text>}
            </Space>
          </div>
          <Space wrap>
            <ProfilePicker
              profiles={(profiles.data?.items ?? []).filter((item) => item.mcp)}
              value={profile}
              change={(value) => {
                setProfile(value);
                setHistoryId(undefined);
                setError(undefined);
              }}
              disabled={!!connection || !!phase}
            />
            {connection ? (
              <>
                <Button
                  onClick={() => void refreshDirectory(connection, profile!)}
                  loading={discovery.pending}
                  disabled={work || !!phase}
                >
                  {t('discover')}
                </Button>
                <Button
                  onClick={() => void disconnect()}
                  disabled={work || !!phase}
                  loading={phase === 'disconnecting'}
                >
                  {t('disconnect')}
                </Button>
              </>
            ) : (
              <Button
                type="primary"
                onClick={() => void connect()}
                loading={phase === 'connecting'}
                disabled={!selectedProfile}
              >
                {t('connect')}
              </Button>
            )}
            {execution.run?.status === 'running' && activeKey !== key && (
              <Button onClick={() => void execution.cancel()}>{t('cancel')}</Button>
            )}
            {discovery.run?.status === 'running' && (
              <Button onClick={() => void discovery.cancel()}>{msg('Cancel discovery', '取消发现')}</Button>
            )}
          </Space>
        </div>
        <ErrorView error={profiles.error || error || discovery.error} />
        {discovery.run?.steps.find((step) => step.error)?.error && (
          <Alert type="error" title={discovery.run.steps.find((step) => step.error)?.error?.message} />
        )}
        {inventory && (
          <Typography.Text type="secondary">
            {msg('Refreshed', '刷新时间')} {new Date(inventory.when).toLocaleString()}
          </Typography.Text>
        )}
        {definition && (
          <details className="mcp-service-details">
            <summary>{msg('Service details', '服务详情')}</summary>
            {definition.instructions && <Typography.Paragraph>{definition.instructions}</Typography.Paragraph>}
            {definition.capabilities && <Code value={definition.capabilities} />}
            {selectedProfile?.mcp && <Code value={selectedProfile.mcp} />}
          </details>
        )}
      </Card>

      {!connection ? (
        <>
          <Alert type="info" title={t('noConnection')} />
          <ScannedMcp />
        </>
      ) : (
        <div className="mcp-layout">
          <Card size="small" className="mcp-directory">
            <div className="stack">
              <Space wrap role="group" aria-label={msg('MCP capability types', 'MCP 能力分类')}>
                {kinds.map((value) => (
                  <Button
                    size="small"
                    type={value === kind ? 'primary' : 'default'}
                    aria-pressed={value === kind}
                    key={value}
                    onClick={() => {
                      if (value !== kind) switchKind(value);
                    }}
                  >
                    {t(value)}
                  </Button>
                ))}
              </Space>
              <Input
                allowClear
                aria-label={msg('Search MCP directory', '搜索 MCP 目录')}
                placeholder={msg('Search name, description or URI', '搜索名称、描述或 URI')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
              {group && (
                <Space wrap>
                  <Label value={group.state} />
                  <Typography.Text type="secondary">
                    {filtered.length} / {group.items.length}
                  </Typography.Text>
                </Space>
              )}
              {group?.error !== undefined && (
                <details>
                  <summary>{t('details')}</summary>
                  <Code value={group.error} />
                </details>
              )}
              {discovery.pending && !inventory ? (
                <Loading />
              ) : (
                <TextButtonList
                  items={filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)}
                  id={(entry) => itemId(entry, kind)}
                  selected={id}
                  name={(entry) => <span title={itemId(entry, kind)}>{title(entry, kind)}</span>}
                  choose={choose}
                />
              )}
              {filtered.length > pageSize && (
                <Pagination
                  size="small"
                  current={currentPage}
                  pageSize={pageSize}
                  total={filtered.length}
                  showSizeChanger={false}
                  onChange={setPage}
                />
              )}
            </div>
          </Card>

          <Card
            size="small"
            className="mcp-inspector"
            title={entry ? title(entry, kind) : msg('MCP workbench', 'MCP 工作台')}
          >
            <Tabs
              activeKey={panel}
              onChange={setPanel}
              items={[
                {
                  key: 'details',
                  label: t('details'),
                  children: entry ? <EntryDetails entry={entry} kind={kind} /> : <EmptyView select />,
                },
                {
                  key: 'test',
                  label: msg('Test', '测试'),
                  children:
                    entry && draft ? (
                      <div className="stack">
                        {entry.description !== undefined && (
                          <Typography.Paragraph>{String(entry.description)}</Typography.Paragraph>
                        )}
                        {(kind === 'resource' || kind === 'template') && (
                          <Field label={t('uri')}>
                            <Input
                              aria-label={t('uri')}
                              readOnly
                              value={kind === 'template' ? (expanded ?? '') : itemId(entry, kind)}
                              placeholder={msg('Fill in the template variables', '请填写模板变量')}
                            />
                          </Field>
                        )}
                        {kind !== 'resource' && (
                          <>
                            <ParameterFields
                              fields={metadataFields(entry, kind)}
                              value={draft.arguments}
                              change={(value) => changeDraft({ arguments: value })}
                            />
                            <details>
                              <summary>{t('argument')}</summary>
                              <JsonField
                                label={t('argument')}
                                value={draft.arguments}
                                change={(value) => changeDraft({ arguments: value })}
                              />
                            </details>
                          </>
                        )}
                        <div className="toolbar mcp-test-actions">
                          <Button
                            type="primary"
                            onClick={() => test(false)}
                            disabled={work || !!phase || (kind === 'template' && expanded === undefined)}
                          >
                            {t(kind === 'tool' ? 'call' : kind === 'prompt' ? 'getPrompt' : 'read')}
                          </Button>
                          <Button
                            onClick={() => test(true)}
                            disabled={!!phase || (kind === 'template' && expanded === undefined)}
                          >
                            {t('saveCase')}
                          </Button>
                          <Typography.Text type="secondary">{selectedProfile?.name}</Typography.Text>
                        </div>
                        <AssertionsEditor
                          rows={draft.checks}
                          change={(checks) => changeDraft({ checks })}
                          result={last?.steps[0]?.result}
                          tool={kind === 'tool'}
                        />
                        <details>
                          <summary>{msg('Request preview', '请求预览')}</summary>
                          <Code
                            value={{
                              profile: selectedProfile?.id,
                              target: itemId(entry, kind),
                              uri: expanded,
                              arguments: kind === 'resource' ? undefined : draft.arguments,
                            }}
                          />
                        </details>
                        <ErrorView error={activeKey === key ? execution.error : undefined} />
                        {last && (
                          <RunView
                            run={last}
                            cancel={() => void execution.cancel()}
                            renderResult={(value) => <McpResult value={value} />}
                          />
                        )}
                      </div>
                    ) : (
                      <EmptyView select />
                    ),
                },
                {
                  key: 'history',
                  label: t('history'),
                  children: (
                    <div className="stack">
                      <ErrorView error={history.error} />
                      {history.loading && !history.data ? (
                        <Loading />
                      ) : (
                        <TextButtonList
                          items={relevant}
                          id={(run) => run.id}
                          selected={historyId}
                          choose={(run) => setHistoryId(run.id)}
                          name={(run) => (
                            <Space wrap>
                              <Label value={run.status} />
                              {new Date(run.started).toLocaleString()}
                              <Tag>{run.subject}</Tag>
                            </Space>
                          )}
                        />
                      )}
                      {previous && (
                        <RunView
                          run={previous}
                          cancel={() => {
                            void command('run cancel', { id: previous.id }).catch(setError);
                          }}
                          renderResult={(value) => <McpResult value={value} />}
                        />
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </div>
      )}
      {save && <SaveCase open close={() => setSave(undefined)} make={() => ({ kind: 'mcp', ...save })} />}
    </div>
  );
}
