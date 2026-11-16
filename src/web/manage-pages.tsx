import { Alert, Button, Card, Input, Modal, Select, Space, Tabs, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { Run, Case, Suite, Versioned } from '../app/runs.js';
import type { Settings } from '../app/config.js';
import type { Snapshot } from '../scanner/model.js';
import type { Profile } from '../protocols/variables.js';
import { download, unwrap, WebError } from './client.js';
import {
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
  TextButtonList,
  json,
  parse,
  useLoad,
  useProfiles,
  useRun,
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
  const { t, revision, refresh, notify, command } = useWorkspace();
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
  let order: string[] = [];
  if (tab === 'suite') {
    try {
      order = (parse(document) as Suite).caseIds ?? [];
    } catch {
      /* JSON editor displays validation on save. */
    }
  }
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
      <div className="split">
        <Card size="small" title={t(tab === 'case' ? 'cases' : tab === 'suite' ? 'suites' : 'history')}>
          <div className="stack">
            <Space>
              <Button onClick={refresh}>{t('reload')}</Button>
              {tab !== 'run' && <Button onClick={() => select()}>{t('create')}</Button>}
            </Space>
            <ErrorView error={tab === 'run' ? runs.error : listing.error} />
            {tab === 'run' ? (
              <TextButtonList
                items={runs.data?.items ?? []}
                id={(run) => run.id}
                name={(run) => (
                  <>
                    {run.subject} <Label value={run.status} />
                  </>
                )}
                selected={action.run?.id}
                choose={action.setRun}
              />
            ) : (
              <TextButtonList<Versioned<Case | Suite>>
                items={listing.data?.items ?? []}
                id={(item) => item.id}
                name={(item) => item.document.name}
                selected={selected?.id}
                choose={(item) => select(item)}
              />
            )}
          </div>
        </Card>
        <div className="stack">
          {tab !== 'run' && (
            <Card size="small" title={selected?.document.name ?? t('edit')}>
              <div className="stack">
                <ErrorView error={error} />
                <JsonField label={t('document')} value={document} change={setDocument} rows={11} />
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
                      <Button
                        loading={action.pending}
                        onClick={() =>
                          void action.start(() => command('test run', { [tab]: selected.id, profile }))
                        }
                      >
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
  catalog: { items: { id: string; name: string; page: string }[] };
  snapshot: string;
};
type WikiExport = { id: string; out: string; locale: string; snapshot: string };
export function WikiPage() {
  const { t, lang, revision, refresh, notify, command, projectId } = useWorkspace();
  const [out, setOut] = useState('');
  const [fileToken, setFileToken] = useState<string>();
  const [snapshot, setSnapshot] = useState<string>();
  const [page, setPage] = useState('README.md');
  const [preview, setPreview] = useState<WikiPreview>();
  const [activeExport, setExport] = useState<WikiExport>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const scans = useLoad(() => command<Listed<Snapshot>>('scan list'), [revision]);
  const exports = useLoad(() => command<Listed<WikiExport>>('wiki list'), [revision]);
  const item = preview?.catalog.items.find((item) => item.page === page);
  useEffect(() => {
    let active = true;
    setNote('');
    if (item)
      void command<{ text: string }>('wiki note-show', { id: item.id })
        .then((result) => {
          if (active) setNote(result.text);
        })
        .catch(setError);
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
          <Button loading={busy} onClick={() => void operation(load)}>
            {t('preview')}
          </Button>
          <Button
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
          {preview && <Button onClick={() => download('catalog.json', preview.catalog)}>{t('export')}</Button>}
          {activeExport && (
            <Button
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
      <div className="split">
        <div className="stack">
          <Card size="small" title={t('wiki')}>
            {preview ? (
              <TextButtonList
                items={[{ page: 'README.md', name: 'README.md' }, ...preview.catalog.items]}
                id={(item) => item.page}
                name={(item) => item.name}
                selected={page}
                choose={(item) => setPage(item.page)}
              />
            ) : (
              <EmptyView />
            )}
          </Card>
          {preview && (
            <Card size="small" title={t('changes')}>
              <Space wrap>
                <TagCount title={t('changes')} items={preview.changed} />
                <TagCount title={t('removed')} items={preview.removed} />
                <TagCount title={t('conflicts')} items={preview.conflicts} />
                <TagCount title={t('orphanNotes')} items={preview.orphanNotes} />
              </Space>
            </Card>
          )}
          <Card size="small" title={t('exports')}>
            <TextButtonList
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
                  setPage('README.md');
                });
              }}
            />
          </Card>
        </div>
        <div className="stack">
          <Card size="small" title={page}>
            {preview ? <Markdown>{preview.pages[page] ?? ''}</Markdown> : <EmptyView select />}
          </Card>
          {item && (
            <Card size="small" title={t('note')}>
              <div className="stack">
                <Input.TextArea
                  value={note}
                  rows={5}
                  aria-label={t('note')}
                  onChange={(event) => setNote(event.target.value)}
                />
                <Button
                  loading={busy}
                  onClick={() =>
                    void operation(async () => {
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
  return (
    <details>
      <summary>
        {title} ({items.length})
      </summary>
      <Code value={items} />
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
              items={profiles.data?.items ?? []}
              id={(item) => item.id}
              name={(item) => item.name}
              selected={profileId}
              choose={chooseProfile}
            />
            <JsonField label={t('document')} value={profile} change={setProfile} rows={10} />
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
