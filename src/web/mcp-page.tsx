import { Alert, Button, Card, Input, Modal, Pagination, Select, Space, Tabs, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { McpLaunchPlan, Run } from '../app/runs.js';
import type { Discovery, McpAction } from '../protocols/mcp.js';
import { mcpVersions } from '../protocols/mcp-versions.js';
import { resourceTemplate } from '../protocols/mcp-template.js';
import { CatalogPage } from './catalog-page.js';
import { SaveCase } from './debug-pages.js';
import { WebError } from './client.js';
import {
  BackToList,
  Code,
  EmptyView,
  ErrorView,
  Field,
  JsonField,
  Label,
  Loading,
  RunView,
  SandboxIssues,
  TextButtonList,
  json,
  useLoad,
  useProfiles,
  useRun,
  useSplitView,
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
type RepositoryTarget = { id: string; name: string; path: string; transport: string; windowsLauncher?: boolean };
type Mode = 'isolated' | 'native';
type LaunchEnvironment = 'docker' | 'native';
type Target = {
  profile?: string;
  service?: string;
  image?: string;
  mcpMode?: Mode;
  protocol?: string;
};
type Approved = { target: Target; plan: McpLaunchPlan & { profile: string; path?: string } };
type Review = Approved & { test?: { body: unknown; item: string } };
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
  return (
    <details>
      <summary>{msg('Project scan records', '项目扫描记录')}</summary>
      <CatalogPage kind="mcp" />
    </details>
  );
}

function LaunchPlanSummary({ review }: { review: Review }) {
  const msg = useMcpText();
  const { plan, target, test } = review;
  const fields: { label: string; value?: string }[] = [
    { label: msg('Configuration', '配置来源'), value: plan.path },
    { label: msg('Working directory', '工作目录'), value: plan.directory },
    { label: msg('Git commit', 'Git 提交'), value: plan.commit },
    { label: msg('Protocol', '协议'), value: plan.protocol ?? target.protocol ?? msg('Automatic', '自动协商') },
    { label: msg('Endpoint', '监听地址'), value: plan.url },
  ];
  if ('image' in plan)
    fields.unshift({ label: msg('Container image', '容器镜像'), value: plan.image + '\n' + plan.imageId });
  return (
    <>
      <div className="mcp-launch-command">
        <Typography.Text type="secondary">{msg('Executable and arguments', '可执行文件与参数')}</Typography.Text>
        <code>{plan.command}</code>
        {plan.args.length > 0 && (
          <ul>
            {plan.args.map((value, index) => (
              <li key={index}>
                <code>{value}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
      <dl className="mcp-launch-fields">
        {fields
          .filter((field) => field.value)
          .map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
      </dl>
      {test && (
        <div>
          <Typography.Text strong>{msg('Test request', '测试请求')}</Typography.Text>
          <Code value={test.body} />
        </div>
      )}
      <details>
        <summary>{msg('Full launch plan', '完整启动计划')}</summary>
        <Code value={plan} />
      </details>
    </>
  );
}

export function McpPage() {
  const pane = useSplitView();
  const { t, command, revision } = useWorkspace();
  const msg = useMcpText();
  const profiles = useProfiles();
  const sources = useLoad(
    () => command<Listed<RepositoryTarget>>('mcp targets', { limit: 500 }),
    [revision, command],
  );
  const discovery = useRun();
  const execution = useRun();
  const [selected, setSelected] = useState<string>();
  const [image, setImage] = useState('');
  const [launch, setLaunch] = useState<Approved>();
  const [review, setReview] = useState<Review>();
  const [resultMode, setResultMode] = useState<Mode>('isolated');
  const [protocol, setProtocol] = useState('auto');
  const [environment, setEnvironment] = useState<LaunchEnvironment>('docker');
  const [preparing, setPreparing] = useState(false);
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
  const [save, setSave] = useState<
    {
      request: McpAction;
      assertions: ReturnType<typeof toAssertions>;
      mode?: Mode;
    } & Omit<Target, 'mcpMode'>
  >();
  const approved = launch?.target.mcpMode === resultMode ? launch : undefined;
  const profile = approved?.plan.profile;
  const selectedProfile = profiles.data?.items.find((item) => selected === 'profile:' + item.id);
  const selectedSource = sources.data?.items.find((item) => selected === 'repo:' + item.id);
  const hasTarget = !!(selectedProfile || selectedSource);
  const activeDiscovery = approved ? discovery.run : undefined;
  const stored = useLoad(async () => {
    if (!selectedProfile && !selectedSource) return;
    const target = selectedSource ? { service: selectedSource.id } : { profile: selectedProfile?.id };
    return {
      selected,
      mode: resultMode,
      run: await command<Run | null>('mcp inventory', { ...target, mcpMode: resultMode }),
    };
  }, [selectedProfile?.id, selectedSource?.id, selected, resultMode, command, revision]);
  const latest =
    activeDiscovery && activeDiscovery.status !== 'running' && activeDiscovery.steps[0]?.result
      ? activeDiscovery
      : stored.data?.selected === selected && stored.data?.mode === resultMode
        ? stored.data?.run
        : undefined;
  const inventory = latest
    ? {
        data: latest.steps[0].result as Discovery,
        when: latest.finished ?? latest.started,
      }
    : undefined;
  const history = useLoad(
    () =>
      profile
        ? command<Listed<Run>>('run list', { kind: 'mcp', profile, limit: 100 })
        : Promise.resolve(undefined),
    [profile, revision],
  );
  const definition = inventory?.data;
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
  const work = preparing || discovery.pending || execution.pending;
  const canPrepare = hasTarget && !work;
  const server = definition?.server;
  const discoveryError = discovery.run?.steps.find((step) => step.error)?.error;

  useEffect(() => {
    const run = execution.run;
    if (activeKey && run && run.status !== 'running') setResults((all) => ({ ...all, [activeKey]: run }));
  }, [activeKey, execution.run]);

  async function prepare() {
    const target: Target = {
      ...(selectedSource ? { service: selectedSource.id } : { profile: selectedProfile?.id }),
      mcpMode: environment === 'native' ? 'native' : 'isolated',
      ...(protocol === 'auto' ? {} : { protocol }),
    };
    if (!target.profile && !target.service) return;
    if (environment === 'docker' && image.trim()) target.image = image.trim();
    setPreparing(true);
    setError(undefined);
    try {
      setReview({ target, plan: await command<Approved['plan']>('mcp plan', target) });
    } catch (error) {
      setError(error);
    } finally {
      setPreparing(false);
    }
  }

  function resetDetails() {
    execution.setRun(undefined);
    setActiveKey(undefined);
    switchKind('tool');
    setDrafts({});
    setResults({});
  }

  function selectService(value: string) {
    setSelected(value);
    setLaunch(undefined);
    discovery.setRun(undefined);
    setResultMode('isolated');
    resetDetails();
    setError(undefined);
  }

  function discover(launch: Review) {
    setReview(undefined);
    if (launch.test) {
      setActiveKey(launch.test.item);
      void execution.start(() =>
        command('mcp batch', {
          body: launch.test!.body,
          ...launch.target,
          approve: launch.plan.fingerprint,
        }),
      );
      return;
    }
    resetDetails();
    discovery.setRun(undefined);
    setLaunch(launch);
    setResultMode(launch.target.mcpMode ?? 'isolated');
    void discovery.start(() => command('mcp probe', { ...launch.target, approve: launch.plan.fingerprint }));
  }

  function switchKind(next: Kind) {
    setKind(next);
    setId(undefined);
    setQuery('');
    setPage(1);
    setHistoryId(undefined);
  }

  function choose(next: Entry) {
    pane.reveal();
    setId(itemId(next, kind));
    setPanel(approved ? 'test' : 'details');
    setHistoryId(undefined);
    setError(undefined);
  }

  function changeDraft(update: Partial<Draft>) {
    if (!draft) return;
    setDrafts((current) => ({ ...current, [key]: { ...draft, ...update } }));
  }

  async function test(keep: boolean) {
    if (!entry || !draft || !approved) return;
    setError(undefined);
    try {
      const request = target(entry, kind, draft.arguments);
      const assertions = toAssertions(draft.checks);
      if (keep) {
        const { mcpMode, ...selection } = approved.target;
        setSave({ request, assertions, ...selection, mode: mcpMode });
        return;
      }
      if (!approved || work) return;
      execution.setRun(undefined);
      setActiveKey(key);
      const body = { schemaVersion: 1, steps: [{ ...request, id: request.type, assertions }] };
      if (approved.target.mcpMode === 'native') {
        setPreparing(true);
        try {
          const plan = await command<Approved['plan']>('mcp plan', { ...approved.target, body });
          setReview({ ...approved, plan, test: { body, item: key } });
        } finally {
          setPreparing(false);
        }
        return;
      }
      void execution.start(() =>
        command('mcp batch', {
          body,
          ...approved.target,
          approve: approved.plan.fingerprint,
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
        <h3 className="mcp-section-title">{msg('Discover MCP capabilities', '发现 MCP 能力')}</h3>
        <form
          className="mcp-launch-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canPrepare) void prepare();
          }}
        >
          <div className="mcp-launch-grid">
            <Field label={msg('MCP service', 'MCP 服务')}>
              <Select
                aria-label={msg('MCP service', 'MCP 服务')}
                placeholder={msg('Select a repository service or profile', '选择仓库服务或本地配置')}
                value={selected}
                onChange={selectService}
                options={[
                  ...(sources.data?.items ?? []).map((item) => ({
                    value: 'repo:' + item.id,
                    label: `${item.name} · ${item.path}${item.windowsLauncher ? ' · Windows' : ''}`,
                  })),
                  ...(profiles.data?.items ?? [])
                    .filter((item) => item.mcp?.command)
                    .map((item) => ({ value: 'profile:' + item.id, label: item.name })),
                ]}
                disabled={work}
              />
            </Field>
            <Field label={msg('Run environment', '运行环境')}>
              <Select
                aria-label={msg('Run environment', '运行环境')}
                virtual={false}
                value={environment}
                disabled={work}
                options={[
                  { label: 'Docker · Linux', value: 'docker' },
                  { label: msg('Local process', '本机进程'), value: 'native' },
                ]}
                onChange={(value) => {
                  setEnvironment(value);
                  setError(undefined);
                }}
              />
            </Field>
            <Field label={msg('Protocol version', '协议版本')}>
              <Select
                aria-label={msg('MCP protocol version', 'MCP 协议版本')}
                value={protocol}
                disabled={work}
                options={[
                  { label: msg('Automatic protocol', '自动协商协议'), value: 'auto' },
                  ...mcpVersions.map((value) => ({ label: value, value })),
                ]}
                onChange={setProtocol}
              />
            </Field>
          </div>
          {environment === 'docker' && (
            <div className="mcp-environment-fields">
              <Field label={msg('Docker image', 'Docker 镜像')}>
                <Input
                  aria-label={msg('Local Docker image', '本机 Docker 镜像')}
                  placeholder={selectedProfile?.mcp?.image ?? 'node:26-alpine'}
                  value={image}
                  disabled={work}
                  onChange={(event) => setImage(event.target.value)}
                />
              </Field>
            </div>
          )}
          <div className="mcp-launch-actions">
            <span>
              {environment === 'native'
                ? msg('Runs temporarily with your local user permissions.', '按当前用户权限在本机临时运行。')
                : msg(
                    'Uses a read-only Git snapshot in an isolated environment.',
                    '在隔离环境中使用只读 Git 快照。',
                  )}
            </span>
            <Space wrap>
              {execution.run?.status === 'running' && activeKey !== key && (
                <Button onClick={() => void execution.cancel()}>{t('cancel')}</Button>
              )}
              {discovery.run?.status === 'running' && (
                <Button onClick={() => void discovery.cancel()}>{msg('Cancel discovery', '取消发现')}</Button>
              )}
              <Button
                htmlType="submit"
                type="primary"
                loading={preparing || discovery.pending}
                disabled={!canPrepare}
              >
                {msg('Review launch plan', '查看启动计划')}
              </Button>
            </Space>
          </div>
        </form>
        <ErrorView error={profiles.error || sources.error || error || (launch && discovery.error)} />
        {discoveryError && (
          <ErrorView error={new WebError(discoveryError.code, discoveryError.message, discoveryError.details)} />
        )}
        {discovery.run?.status === 'running' && (
          <Alert
            type="info"
            showIcon
            role="status"
            title={
              {
                preparing: msg('Preparing the service', '准备服务'),
                launch: msg('Launching the service', '启动服务'),
                ready: msg('Waiting for the endpoint', '等待服务就绪'),
                negotiate: msg('Negotiating protocol', '协商协议'),
                list: msg('Reading capability pages', '读取能力清单'),
                cleanup: msg('Closing the service', '正在关闭服务'),
              }[discovery.run.mcpStage ?? 'preparing']
            }
            description={
              discovery.run.steps[0]?.progress ? <Code value={discovery.run.steps[0].progress} /> : undefined
            }
          />
        )}
      </Card>
      {hasTarget && (
        <Card size="small" className="mcp-results">
          <div className="mcp-results-header">
            <h3 className="mcp-section-title">{msg('Discovery results', '发现结果')}</h3>
            <Space.Compact role="group" aria-label={msg('Saved result type', '保存的结果类型')}>
              {(['isolated', 'native'] as const).map((value) => (
                <Button
                  key={value}
                  size="small"
                  type={value === resultMode ? 'primary' : 'default'}
                  aria-pressed={value === resultMode}
                  disabled={work}
                  onClick={() => {
                    if (value === resultMode) return;
                    setResultMode(value);
                    resetDetails();
                  }}
                >
                  {value === 'isolated' ? msg('Isolated results', '隔离记录') : msg('Local results', '本机记录')}
                </Button>
              ))}
            </Space.Compact>
          </div>
          <ErrorView error={stored.error} />
          {inventory && (
            <Space wrap size={[6, 6]}>
              {server && <strong>{server.name}</strong>}
              {server?.version && <Tag>{server.version}</Tag>}
              {definition?.protocolVersion && <Tag>{definition.protocolVersion}</Tag>}
              <Typography.Text type="secondary">
                {msg('Discovered', '发现时间')} {new Date(inventory.when).toLocaleString()}
              </Typography.Text>
            </Space>
          )}
          {(activeDiscovery?.sandboxes ?? latest?.sandboxes)?.map((sandbox) => (
            <Alert
              key={sandbox.instance}
              type={sandbox.cleanup.state === 'removed' ? 'success' : 'error'}
              showIcon
              title={
                sandbox.cleanup.state === 'removed'
                  ? sandbox.mode === 'native'
                    ? msg('Local process closed', '本机进程已关闭')
                    : msg('Sandbox removed', '隔离实例已回收')
                  : msg('MCP cleanup needs attention', 'MCP 实例清理失败')
              }
              description={sandbox.cleanup.message ?? sandbox.commit.slice(0, 12)}
            />
          ))}
          {definition ? (
            <details className="mcp-service-details">
              <summary>{msg('Service details', '服务详情')}</summary>
              {definition.instructions && <Typography.Paragraph>{definition.instructions}</Typography.Paragraph>}
              {definition.capabilities && <Code value={definition.capabilities} />}
              {selectedProfile?.mcp && <Code value={selectedProfile.mcp} />}
            </details>
          ) : (
            !discovery.pending &&
            !stored.error &&
            (stored.loading ? (
              <Loading />
            ) : (
              <Typography.Text type="secondary">
                {msg('No results saved for this service and run type.', '此服务在所选方式下暂无发现记录。')}
              </Typography.Text>
            ))
          )}
        </Card>
      )}

      {inventory && (
        <div className="mcp-layout detail-split">
          <div ref={pane.listRef} className="list-anchor" tabIndex={-1}>
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
                    label={msg('MCP capability list', 'MCP 能力列表')}
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
          </div>

          <div ref={pane.detailRef} className="stack list-detail" tabIndex={-1}>
            <BackToList onClick={pane.back} />
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
                              disabled={work || !approved || (kind === 'template' && expanded === undefined)}
                            >
                              {t(kind === 'tool' ? 'call' : kind === 'prompt' ? 'getPrompt' : 'read')}
                            </Button>
                            <Button
                              onClick={() => test(true)}
                              disabled={!approved || (kind === 'template' && expanded === undefined)}
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
        </div>
      )}
      <ScannedMcp />
      <Modal
        open={!!review}
        width={610}
        className="mcp-launch-dialog"
        title={
          review?.target.mcpMode === 'native'
            ? msg('Review local launch', '确认本机临时启动')
            : msg('Review isolated launch', '确认隔离启动')
        }
        onCancel={() => setReview(undefined)}
        onOk={() => {
          if (review && !review.plan.issues.length) discover(review);
        }}
        okText={review?.test ? msg('Start and test', '启动并测试') : msg('Start and discover', '启动并发现')}
        okButtonProps={{ disabled: Boolean(review?.plan.issues.length) }}
        cancelText={msg('Cancel', '取消')}
      >
        {review && (
          <div className="stack">
            <SandboxIssues issues={review.plan.issues} />
            <Typography.Text>
              {review.target.mcpMode === 'native'
                ? msg(
                    'The service runs with your local account and can access its files, applications, and network.',
                    '服务按当前账户权限运行，可访问该账户能使用的文件、应用和网络。',
                  )
                : msg(
                    'The service runs with a read-only Git snapshot and isolated networking.',
                    '服务使用只读 Git 快照和隔离网络。',
                  )}
            </Typography.Text>
            <LaunchPlanSummary review={review} />
          </div>
        )}
      </Modal>
      {save && <SaveCase open close={() => setSave(undefined)} make={() => ({ kind: 'mcp', ...save })} />}
    </div>
  );
}
