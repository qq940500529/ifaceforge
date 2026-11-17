import { Alert, Button, Card, Input, Modal, Select, Space, Tabs, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { Run, Case, Suite, Versioned } from '../app/runs.js';
import type { SandboxPlan } from '../protocols/mcp-sandbox.js';
import type { Settings } from '../app/config.js';
import type { Kind, Snapshot } from '../scanner/model.js';
import type { Profile } from '../protocols/variables.js';
import { mcpVersions } from '../protocols/mcp-versions.js';
import { download, unwrap, WebError } from './client.js';
import {
  BackToList,
  Code,
  EmptyView,
  ErrorView,
  Field,
  JsonField,
  Label,
  Loading,
  Markdown,
  ProfilePicker,
  RunPanel,
  SandboxIssues,
  TextButtonList,
  json,
  parse,
  useLoad,
  useProfiles,
  useRun,
  useSplitView,
  useWorkspace,
  type Listed,
} from './components.js';

const sampleCase = {
  schemaVersion: 1,
  id: '',
  name: '',
  kind: 'http',
  request: { method: 'GET', url: 'http://127.0.0.1:3000/' },
  assertions: [{ type: 'status', equals: 200 }],
};
const sampleSuite = { schemaVersion: 1, id: '', name: '', caseIds: [] };

export function TestPage() {
  const pane = useSplitView();
  const { t, lang, revision, refresh, notify, command } = useWorkspace();
  const cases = useLoad(() => command<Listed<Versioned<Case>>>('case list', { limit: 500 }), [revision]);
  const suites = useLoad(() => command<Listed<Versioned<Suite>>>('suite list', { limit: 500 }), [revision]);
  const runs = useLoad(() => command<Listed<Run>>('run list', { limit: 100 }), [revision]);
  const profiles = useProfiles();
  const action = useRun();
  const [tab, setTab] = useState('case');
  const [selected, setSelected] = useState<Versioned<Case | Suite>>();
  const [document, setDocument] = useState(json(sampleCase));
  const [profile, setProfile] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState<{
    target: { case?: string; suite?: string; profile?: string };
    plans: SandboxPlan[];
    fingerprint: string;
  }>();
  async function startTest() {
    if (!selected) return;
    const target = tab === 'case' ? { case: selected.id, profile } : { suite: selected.id, profile };
    setError(undefined);
    try {
      const plan = await command<{ plans: SandboxPlan[]; fingerprint: string | null }>('test plan', target);
      if (plan.fingerprint) setReview({ target, plans: plan.plans, fingerprint: plan.fingerprint });
      else await action.start(() => command('test run', target));
    } catch (error) {
      setError(error);
    }
  }
  function select(record?: Versioned<Case | Suite>, type = tab) {
    setSelected(record);
    setDocument(json(record?.document ?? (type === 'case' ? sampleCase : sampleSuite)));
    setError(undefined);
  }
  async function save() {
    setError(undefined);
    setSaving(true);
    try {
      const record = await command<Versioned<Case | Suite>>(tab + ' put', {
        body: parse(document),
        replace: !!selected,
        version: selected?.version,
      });
      select(record);
      refresh();
      notify(t('success'));
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    setError(undefined);
    setSaving(true);
    try {
      await command(tab + ' remove', { id: selected?.id });
      select();
      refresh();
      setConfirm(false);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  }
  let draft: Case | Suite | undefined;
  try {
    const value = parse(document);
    if (value && typeof value === 'object' && 'name' in value && 'id' in value) draft = value as Case | Suite;
  } catch {
    /* The raw editor remains usable while the document is incomplete. */
  }
  const order = draft && 'caseIds' in draft ? draft.caseIds : [];
  function updateOrder(caseIds: string[]) {
    try {
      setDocument(json({ ...(parse(document) as Suite), caseIds }));
    } catch (error) {
      setError(error);
    }
  }
  const listing = tab === 'case' ? cases : suites;
  return (
    <div className="stack">
      <Tabs
        activeKey={tab}
        onChange={(type) => {
          setTab(type);
          select(undefined, type);
        }}
        items={[
          { key: 'case', label: t('cases') },
          { key: 'suite', label: t('suites') },
          { key: 'run', label: t('history') },
        ]}
      />
      <div className="split detail-split">
        <div ref={pane.listRef} className="list-anchor" tabIndex={-1}>
          <Card size="small" title={t(tab === 'case' ? 'cases' : tab === 'suite' ? 'suites' : 'history')}>
            <div className="stack">
              <Space>
                <Button onClick={refresh}>{t('reload')}</Button>
                {tab !== 'run' && (
                  <Button
                    onClick={() => {
                      select();
                      pane.reveal();
                    }}
                  >
                    {t('create')}
                  </Button>
                )}
              </Space>
              <ErrorView error={tab === 'run' ? runs.error : listing.error} />
              {tab === 'run' ? (
                <TextButtonList
                  label={t('history')}
                  items={runs.data?.items ?? []}
                  id={(run) => run.id}
                  name={(run) => (
                    <>
                      {run.subject} <Label value={run.status} />
                    </>
                  )}
                  selected={action.run?.id}
                  choose={(run) => {
                    action.setRun(run);
                    pane.reveal();
                  }}
                />
              ) : (
                <TextButtonList<Versioned<Case | Suite>>
                  label={t(tab === 'case' ? 'cases' : 'suites')}
                  items={listing.data?.items ?? []}
                  id={(item) => item.id}
                  name={(item) => item.document.name}
                  selected={selected?.id}
                  choose={(item) => {
                    select(item);
                    pane.reveal();
                  }}
                />
              )}
            </div>
          </Card>
        </div>
        <div ref={pane.detailRef} className="stack list-detail" tabIndex={-1}>
          <BackToList onClick={pane.back} />
          {tab !== 'run' && (
            <Card size="small" title={selected?.document.name ?? t('edit')}>
              <div className="stack">
                <ErrorView error={error} />
                {draft && (
                  <div className="toolbar">
                    <Field label={t('caseId')}>
                      <Input
                        readOnly={!!selected}
                        value={draft.id}
                        onChange={(e) => setDocument(json({ ...draft, id: e.target.value }))}
                      />
                    </Field>
                    <Field label={t('name')}>
                      <Input
                        value={draft.name}
                        onChange={(e) => setDocument(json({ ...draft, name: e.target.value }))}
                      />
                    </Field>
                  </div>
                )}
                {tab === 'suite' && Array.isArray(order) && (
                  <div>
                    <Typography.Text strong>{t('caseOrder')}</Typography.Text>
                    {order.map((id, index) => (
                      <div key={index} className="order">
                        <span>{id}</span>
                        <Space>
                          {[-1, 1].map((offset) => (
                            <Button
                              key={offset}
                              size="small"
                              disabled={index + offset < 0 || index + offset >= order.length}
                              onClick={() => {
                                const next = [...order];
                                [next[index], next[index + offset]] = [next[index + offset], next[index]];
                                updateOrder(next);
                              }}
                            >
                              {t(offset === -1 ? 'up' : 'down')}
                            </Button>
                          ))}
                          <Button
                            size="small"
                            onClick={() => updateOrder(order.filter((_, current) => current !== index))}
                          >
                            {t('remove')}
                          </Button>
                        </Space>
                      </div>
                    ))}
                    <Select<string | undefined>
                      virtual={false}
                      aria-label={t('caseId')}
                      placeholder={t('selectItem')}
                      value={undefined}
                      onChange={(id) => {
                        if (id) updateOrder([...order, id]);
                      }}
                      options={(cases.data?.items ?? []).map((item) => ({
                        value: item.id,
                        label: item.document.name,
                      }))}
                    />
                  </div>
                )}
                <details open={draft ? undefined : true}>
                  <summary>{t('document')}</summary>
                  <JsonField label={t('document')} value={document} change={setDocument} rows={11} />
                </details>
                <Space wrap>
                  <Button type="primary" loading={saving} onClick={() => void save()}>
                    {t('save')}
                  </Button>
                  {selected && (
                    <>
                      <Button danger onClick={() => setConfirm(true)}>
                        {t('remove')}
                      </Button>
                      <Button
                        onClick={() =>
                          void command(tab + ' export', { id: selected.id })
                            .then((data) => download(selected.id + '.json', data))
                            .catch(setError)
                        }
                      >
                        {t('export')}
                      </Button>
                      <ProfilePicker profiles={profiles.data?.items ?? []} value={profile} change={setProfile} />
                      <Button loading={action.pending} onClick={() => void startTest()}>
                        {t('run')}
                      </Button>
                    </>
                  )}
                </Space>
              </div>
            </Card>
          )}
          <Card size="small" title={t('report')}>
            <RunPanel action={action} />
          </Card>
        </div>
      </div>
      <Modal
        open={!!review}
        title={lang === 'zh-CN' ? '确认隔离测试' : 'Review isolated tests'}
        onCancel={() => setReview(undefined)}
        okText={lang === 'zh-CN' ? '运行测试' : 'Run tests'}
        okButtonProps={{ disabled: review?.plans.some((plan) => plan.issues.length > 0) }}
        onOk={() => {
          if (!review || review.plans.some((plan) => plan.issues.length)) return;
          setReview(undefined);
          void action.start(() => command('test run', { ...review.target, approve: review.fingerprint }));
        }}
      >
        {review && <SandboxIssues issues={review.plans.flatMap((plan) => plan.issues)} />}
        <Code value={review?.plans} />
      </Modal>
      <Modal
        open={confirm}
        title={t('deleteConfirm')}
        onCancel={() => setConfirm(false)}
        onOk={() => void remove()}
        confirmLoading={saving}
      />
    </div>
  );
}

type WikiPreview = {
  out: string;
  pages: Record<string, string>;
  changed: string[];
  removed: string[];
  conflicts: string[];
  orphanNotes: string[];
  catalog: { items: { id: string; kind: Kind; name: string; summary: string; page: string }[] };
  snapshot: string;
};
type WikiExport = { id: string; out: string; locale: string; snapshot: string };
const wikiKinds = ['api', 'mcp', 'skill'] as const;
const wikiHome = 'README.md';
const wikiSections = new Map([
  ['#http-api', 'http-api'],
  ['#mcp', 'mcp'],
  ['#skills', 'skills'],
  ['#' + encodeURI('技能'), 'skills'],
]);

export function WikiPage() {
  const pane = useSplitView();
  const { t, lang, revision, refresh, notify, command, projectId } = useWorkspace();
  const [out, setOut] = useState('');
  const [fileToken, setFileToken] = useState<string>();
  const [snapshot, setSnapshot] = useState<string>();
  const [selectedPage, setPage] = useState(wikiHome);
  const [category, setCategory] = useState<Kind>();
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<WikiPreview>();
  const [activeExport, setExport] = useState<WikiExport>();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const scans = useLoad(() => command<Listed<Snapshot>>('scan list'), [revision]);
  const exports = useLoad(() => command<Listed<WikiExport>>('wiki list'), [revision]);
  const msg = (en: string, cn: string) => (lang === 'zh-CN' ? cn : en);
  const items = useMemo(() => new Map(preview?.catalog.items.map((entry) => [entry.page, entry])), [preview]);
  const item = items.get(selectedPage);
  const page = item?.page ?? wikiHome;
  const term = query.trim().normalize('NFKC').toLowerCase();
  const filtered = (preview?.catalog.items ?? []).filter(
    (entry) =>
      (!category || category === entry.kind) &&
      [entry.name, entry.summary].some((text) => text.normalize('NFKC').toLowerCase().includes(term)),
  );
  function openPage(path: string) {
    setPage(path);
    pane.reveal();
  }
  function wikiLink(href: string) {
    if (page === wikiHome && items.has(href)) return () => openPage(href);
    if (page !== wikiHome && href === '../README.md') return () => openPage(wikiHome);
  }
  const note = item ? notes[item.id] : undefined;
  useEffect(() => {
    let active = true;
    if (item && note === undefined)
      void command<{ text: string }>('wiki note-show', { id: item.id })
        .then((result) => {
          if (active)
            setNotes((drafts) =>
              Object.hasOwn(drafts, item.id) ? drafts : { ...drafts, [item.id]: result.text },
            );
        })
        .catch((error: unknown) => {
          if (active) setError(error);
        });
    return () => {
      active = false;
    };
  }, [item?.id]);
  async function operation(task: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await task();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  const parameters = () => ({ snapshot, out: out || undefined, lang, fileToken });
  const load = async () => setPreview(await command('wiki preview', parameters()));
  return (
    <div className="stack">
      <ErrorView error={error} />
      <Card size="small">
        <div className="toolbar">
          <Select
            aria-label={t('notScanned')}
            placeholder={t('snapshot', { id: '' })}
            allowClear
            value={snapshot}
            onChange={setSnapshot}
            options={(scans.data?.items ?? [])
              .filter((scan) => scan.complete)
              .map((scan) => ({ value: scan.id, label: scan.id }))}
            style={{ minWidth: 180 }}
          />
          <Input
            aria-label={t('output')}
            className="grow"
            value={out}
            placeholder={t('defaultOutput')}
            readOnly={!!projectId}
            onChange={(event) => setOut(event.target.value)}
          />
          {projectId && window.ifaceforge && (
            <>
              <Button
                onClick={() =>
                  void operation(async () => {
                    const picked = await unwrap(window.ifaceforge!.chooseFile(projectId, 'wiki'));
                    if (picked) {
                      setOut(picked.path);
                      setFileToken(picked.token);
                    }
                  })
                }
              >
                {lang === 'zh-CN' ? '选择目录' : 'Choose folder'}
              </Button>
              {fileToken && (
                <Button
                  onClick={() => {
                    setOut('');
                    setFileToken(undefined);
                  }}
                >
                  {t('defaultOutput')}
                </Button>
              )}
            </>
          )}
          <Button data-testid="wiki-preview" loading={busy} onClick={() => void operation(load)}>
            {t('preview')}
          </Button>
          <Button
            data-testid="wiki-build"
            type="primary"
            loading={busy}
            onClick={() =>
              void operation(async () => {
                setExport(await command('wiki build', parameters()));
                await load();
                refresh();
                notify(t('success'));
              })
            }
          >
            {t('build')}
          </Button>
          {preview && (
            <Button data-testid="wiki-export" onClick={() => download('catalog.json', preview.catalog)}>
              {t('export')}
            </Button>
          )}
          {activeExport && (
            <Button
              data-testid="wiki-open"
              onClick={() =>
                void operation(async () => {
                  await command('wiki open', { id: activeExport.id });
                })
              }
            >
              {t('openDirectory')}
            </Button>
          )}
        </div>
      </Card>
      <div className="split detail-split wiki-split">
        <div ref={pane.listRef} className="stack list-anchor wiki-pages" tabIndex={-1}>
          <Card size="small" className="wiki-navigation" title={msg('Page directory', '页面目录')}>
            {preview ? (
              <div className="wiki-navigation-body">
                <button
                  type="button"
                  className="wiki-page-button wiki-home-link list-button"
                  aria-pressed={page === wikiHome}
                  onClick={() => openPage(wikiHome)}
                >
                  {msg('Wiki overview', 'Wiki 总览')}
                  <span>README.md</span>
                </button>
                <Input
                  allowClear
                  aria-label={msg('Search Wiki pages', '搜索 Wiki 页面')}
                  placeholder={msg('Search by name or description', '搜索名称或说明')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className="wiki-filters">
                  <Select<Kind | 'all'>
                    aria-label={msg('Wiki page category', 'Wiki 页面分类')}
                    virtual={false}
                    value={category ?? 'all'}
                    onChange={(value) => setCategory(value === 'all' ? undefined : value)}
                    options={[
                      { value: 'all' as const, label: msg('All categories', '全部分类') },
                      ...wikiKinds.map((kind) => ({ value: kind, label: t(kind) })),
                    ]}
                  />
                  <Typography.Text type="secondary" aria-live="polite">
                    {filtered.length} / {items.size}
                  </Typography.Text>
                </div>
                <div
                  className="wiki-page-list scroll-list"
                  role="region"
                  aria-label={msg('Wiki pages', 'Wiki 页面列表')}
                >
                  {filtered.map((entry) => (
                    <button
                      key={entry.page}
                      type="button"
                      title={entry.name}
                      className="wiki-page-button list-button"
                      aria-label={entry.name}
                      aria-pressed={page === entry.page}
                      onClick={() => openPage(entry.page)}
                    >
                      <Label value={entry.kind} />
                      <span>{entry.name}</span>
                    </button>
                  ))}
                  {filtered.length === 0 && <EmptyView />}
                </div>
              </div>
            ) : (
              <EmptyView />
            )}
          </Card>
        </div>
        <div className="stack wiki-meta">
          {preview && (
            <Card size="small" title={msg('Export changes', '导出变更')}>
              <div className="wiki-changes">
                <TagCount title={t('changes')} items={preview.changed} />
                <TagCount title={t('removed')} items={preview.removed} />
                <TagCount title={t('conflicts')} items={preview.conflicts} />
                <TagCount title={t('orphanNotes')} items={preview.orphanNotes} />
              </div>
            </Card>
          )}
          <Card size="small" title={t('exports')}>
            <TextButtonList
              label={t('exports')}
              items={exports.data?.items ?? []}
              id={(entry) => entry.id}
              name={(entry) => entry.out}
              selected={activeExport?.id}
              choose={(entry) => {
                setExport(entry);
                setSnapshot(entry.snapshot);
                if (!projectId) setOut(entry.out);
                void operation(async () => {
                  setPreview(
                    await command('wiki preview', {
                      snapshot: entry.snapshot,
                      out: entry.out,
                      lang: entry.locale as 'en' | 'zh-CN',
                    }),
                  );
                  setPage(wikiHome);
                  pane.reveal();
                });
              }}
            />
          </Card>
        </div>
        <div ref={pane.detailRef} className="stack list-detail wiki-detail" tabIndex={-1}>
          <BackToList onClick={pane.back} />
          <Card size="small" className="wiki-document">
            {preview ? (
              <Markdown wikiLink={wikiLink} wikiSections={page === wikiHome ? wikiSections : undefined}>
                {preview.pages[page] ?? ''}
              </Markdown>
            ) : (
              <EmptyView select />
            )}
          </Card>
          {item && (
            <Card size="small" title={t('note')}>
              <div className="stack">
                <Input.TextArea
                  value={note ?? ''}
                  disabled={note === undefined || busy}
                  rows={5}
                  aria-label={t('note')}
                  onChange={(event) => setNotes((drafts) => ({ ...drafts, [item.id]: event.target.value }))}
                />
                <Button
                  loading={busy}
                  disabled={note === undefined}
                  onClick={() =>
                    void operation(async () => {
                      if (note === undefined) return;
                      await command('wiki note-put', { id: item.id, body: note });
                      await load();
                      notify(t('success'));
                    })
                  }
                >
                  {t('noteSave')}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
function TagCount({ title, items }: { title: string; items: string[] }) {
  const { lang } = useWorkspace();
  return (
    <details>
      <summary>
        {title} <span>{items.length}</span>
      </summary>
      {items.length ? (
        <ul className="scroll-list">
          {items.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>{lang === 'zh-CN' ? '没有条目' : 'No entries'}</p>
      )}
    </details>
  );
}

const sampleProfile = {
  schemaVersion: 1,
  id: '',
  name: '',
  http: { baseUrl: 'http://127.0.0.1:3000' },
  variables: {},
};
export function SettingsPage() {
  const { t, lang, project, revision, refresh, notify, command, projectId } = useWorkspace();
  const config = useLoad(
    () => command<{ settings: Settings; scan: Record<string, unknown>; source: string }>('config show'),
    [revision],
  );
  const profiles = useProfiles();
  const [scan, setScan] = useState('{}');
  const [profile, setProfile] = useState(json(sampleProfile));
  const [profileId, setProfileId] = useState('');
  const [path, setPath] = useState('');
  const [restoreFile, setRestoreFile] = useState<{ path: string; token: string }>();
  const desktop = projectId ? window.ifaceforge : undefined;
  const [date, setDate] = useState('');
  const [preview, setPreview] = useState<{ ids: string[]; applied: boolean }>();
  const [confirm, setConfirm] = useState<'restore' | 'remove' | 'prune'>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (config.data) setScan(json(config.data.scan));
  }, [config.data]);
  async function operation(task: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await task();
      refresh();
      notify(t('success'));
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  const settings = (override?: unknown) => ({ schemaVersion: 1, locale: lang, scan: override });
  const chooseProfile = (item?: Profile) => {
    setProfileId(item?.id ?? '');
    setProfile(json(item ?? sampleProfile));
  };
  const prune = async (apply: boolean) => setPreview(await command('data prune', { before: date, apply }));
  return (
    <div className="stack">
      <ErrorView error={error} />
      <Card size="small" title={t('project')}>
        <div className="stack">
          <Space wrap>
            <strong>{t('project')}</strong>
            <Typography.Text code copyable>
              {project.root}
            </Typography.Text>
          </Space>
          <Space wrap>
            <strong>{t('data')}</strong>
            <Typography.Text code copyable>
              {project.data}
            </Typography.Text>
          </Space>
          <Space>
            <strong>{t('branch')}</strong>
            {project.branch}
          </Space>
        </div>
      </Card>
      <div className="split split-even">
        <div className="stack">
          <Card size="small" title={t('scanSettings')}>
            {config.loading && !config.data ? (
              <Loading />
            ) : (
              <div className="stack">
                <ErrorView error={config.error} />
                <JsonField label={t('scanSettings')} value={scan} change={setScan} />
                <Space wrap>
                  <Button
                    type="primary"
                    loading={busy}
                    onClick={() => void operation(() => command('config apply', { body: settings(parse(scan)) }))}
                  >
                    {t('localOverride')}
                  </Button>
                  <Button
                    loading={busy}
                    onClick={() => void operation(() => command('config apply', { body: settings() }))}
                  >
                    {t('clearOverride')}
                  </Button>
                </Space>
              </div>
            )}
          </Card>
          <Card size="small" title={t('maintenance')}>
            <div className="stack">
              {!desktop && (
                <Field label={t('backupPath')}>
                  <Input value={path} onChange={(event) => setPath(event.target.value)} />
                </Field>
              )}
              <Space wrap>
                <Button
                  loading={busy}
                  onClick={() =>
                    void operation(async () => {
                      const picked = desktop ? await unwrap(desktop.chooseFile(projectId!, 'backup')) : undefined;
                      if (desktop && !picked) return;
                      return command('data backup', { out: path, fileToken: picked?.token });
                    })
                  }
                >
                  {t('backup')}
                </Button>
                <Button
                  onClick={() =>
                    void (async () => {
                      try {
                        const picked = desktop
                          ? await unwrap(desktop.chooseFile(projectId!, 'restore'))
                          : undefined;
                        if (desktop && !picked) return;
                        setRestoreFile(picked ?? undefined);
                        setConfirm('restore');
                      } catch (error) {
                        setError(error);
                      }
                    })()
                  }
                >
                  {t('restore')}
                </Button>
              </Space>
              <Field label={t('cutoff')}>
                <Input
                  type="date"
                  value={date}
                  onChange={(event) => {
                    setDate(event.target.value);
                    setPreview(undefined);
                  }}
                />
              </Field>
              <Space wrap>
                <Button loading={busy} onClick={() => void operation(() => prune(false))}>
                  {t('prune')}
                </Button>
                {preview && !preview.applied && (
                  <Button danger onClick={() => setConfirm('prune')}>
                    {t('applyPrune')}
                  </Button>
                )}
              </Space>
              {preview && <Alert type="info" title={t('removedCount', { count: preview.ids.length })} />}
            </div>
          </Card>
        </div>
        <Card size="small" title={t('environments')}>
          <div className="stack">
            <ErrorView error={profiles.error} />
            <TextButtonList
              label={t('environments')}
              items={profiles.data?.items ?? []}
              id={(item) => item.id}
              name={(item) => item.name}
              selected={profileId}
              choose={chooseProfile}
            />
            <ProfileFields value={profile} change={setProfile} existing={!!profileId} />
            <Space wrap>
              <Button onClick={() => chooseProfile()}>{t('create')}</Button>
              <Button
                type="primary"
                loading={busy}
                onClick={() =>
                  void operation(async () => {
                    chooseProfile(await command('profile put', { body: parse(profile) }));
                  })
                }
              >
                {t('save')}
              </Button>
              {!!profileId && (
                <Button danger onClick={() => setConfirm('remove')}>
                  {t('remove')}
                </Button>
              )}
            </Space>
          </div>
        </Card>
      </div>
      <Modal
        open={!!confirm}
        title={t(confirm === 'restore' ? 'restoreConfirm' : 'deleteConfirm')}
        confirmLoading={busy}
        onCancel={() => setConfirm(undefined)}
        onOk={() =>
          void operation(async () => {
            if (confirm === 'restore')
              await command('data restore', { file: path, fileToken: restoreFile?.token, replace: true });
            else if (confirm === 'prune') await prune(true);
            else if (confirm === 'remove') {
              await command('profile remove', { id: profileId });
              chooseProfile();
            } else throw new WebError('INVALID_ARGUMENT', '', null);
            setConfirm(undefined);
          })
        }
      >
        {confirm === 'restore'
          ? (restoreFile?.path ?? path)
          : confirm === 'prune'
            ? preview?.ids.length
            : profileId}
      </Modal>
    </div>
  );
}

function ProfileFields({
  value,
  change,
  existing,
}: {
  value: string;
  change: (value: string) => void;
  existing: boolean;
}) {
  const { t, lang } = useWorkspace();
  const label = (en: string, zh: string) => (lang === 'zh-CN' ? zh : en);
  let profile: Profile | undefined;
  try {
    const draft = parse(value) as Partial<Profile> | null;
    if (draft && typeof draft.id === 'string' && typeof draft.name === 'string') profile = draft as Profile;
  } catch {
    // The JSON editor remains available for correcting invalid input.
  }
  const update = (fields: Partial<Profile>) => change(json({ ...profile, ...fields }));
  const mcp = profile?.mcp;
  return (
    <div className="stack">
      {profile && (
        <>
          <div className="toolbar">
            <Field label={label('Profile ID', '环境 ID')}>
              <Input
                readOnly={existing}
                value={profile.id}
                onChange={(event) => update({ id: event.target.value })}
              />
            </Field>
            <Field label={t('name')}>
              <Input value={profile.name} onChange={(event) => update({ name: event.target.value })} />
            </Field>
          </div>
          <Field label={label('HTTP base URL', 'HTTP 基础 URL')}>
            <Input
              value={profile.http?.baseUrl ?? ''}
              onChange={(event) =>
                update({
                  http: { ...profile?.http, baseUrl: event.target.value || undefined },
                })
              }
            />
          </Field>
          <Field label={label('MCP transport', 'MCP 传输方式')}>
            <Select
              aria-label={label('MCP transport', 'MCP 传输方式')}
              value={mcp?.transport === 'sse' ? undefined : mcp?.transport}
              placeholder={label('Select transport', '选择传输方式')}
              options={[
                { value: 'stdio', label: 'stdio' },
                { value: 'streamableHttp', label: 'Streamable HTTP' },
              ]}
              allowClear
              virtual={false}
              onChange={(transport: 'stdio' | 'streamableHttp' | undefined) =>
                update({
                  mcp:
                    transport === 'stdio'
                      ? { transport, command: '' }
                      : transport
                        ? { transport, url: '', command: '' }
                        : undefined,
                })
              }
            />
          </Field>
          {mcp && (
            <>
              <div className="toolbar">
                <Field label={label('Container executable', '容器内可执行程序')}>
                  <Input
                    value={mcp.command ?? ''}
                    placeholder="node"
                    onChange={(event) => update({ mcp: { ...mcp, command: event.target.value } })}
                  />
                </Field>
                <Field label={label('Docker image', 'Docker 镜像')}>
                  <Input
                    value={mcp.image ?? ''}
                    placeholder="node:26-alpine"
                    onChange={(event) => update({ mcp: { ...mcp, image: event.target.value || undefined } })}
                  />
                </Field>
              </div>
              <Field label={label('Container arguments (one per line)', '容器参数（每行一项）')}>
                <Input.TextArea
                  rows={2}
                  value={mcp.args?.join('\n') ?? ''}
                  onChange={(event) => update({ mcp: { ...mcp, args: event.target.value.split('\n') } })}
                />
              </Field>
            </>
          )}
          {mcp && (
            <Field label={label('MCP protocol revision', 'MCP 协议版本')}>
              <Select
                aria-label={label('MCP protocol revision', 'MCP 协议版本')}
                placeholder={label('Automatic', '自动协商')}
                allowClear
                value={mcp.protocolVersion}
                options={mcpVersions.map((version) => ({ value: version, label: version }))}
                onChange={(protocolVersion) => update({ mcp: { ...mcp, protocolVersion } })}
              />
            </Field>
          )}
          {mcp && mcp.transport !== 'stdio' && (
            <Field label={label('MCP URL', 'MCP 地址')}>
              <Input value={mcp.url} onChange={(event) => update({ mcp: { ...mcp, url: event.target.value } })} />
            </Field>
          )}
        </>
      )}
      <details open={profile ? undefined : true}>
        <summary>{t('document')}</summary>
        <JsonField label={t('document')} value={value} change={change} rows={10} />
      </details>
    </div>
  );
}
