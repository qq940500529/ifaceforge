import { Button, Card, Input, InputNumber, Modal, Select, Space, Typography } from 'antd';
import { useRef, useState } from 'react';
import type { Assertion } from '../app/api.js';
import type { Case } from '../app/runs.js';
import type { HttpRequest } from '../protocols/http.js';
import type { Pair } from '../protocols/variables.js';
import type { Entity } from '../scanner/model.js';
import { copyText, download, unwrap } from './client.js';
import { CatalogList, EntityDetail, useCatalog } from './catalog-page.js';
import {
  BackToList,
  Code,
  ErrorView,
  Field,
  JsonField,
  ProfilePicker,
  RunPanel,
  json,
  parse,
  useProfiles,
  useRun,
  useSplitView,
  useWorkspace,
} from './components.js';

export function SaveCase({ open, close, make }: { open: boolean; close: () => void; make: () => Partial<Case> }) {
  const { t, refresh, notify, command } = useWorkspace();
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
  const pane = useSplitView();
  const { lang, t, refresh, notify, command, projectId } = useWorkspace();
  const list = useCatalog('api');
  const profiles = useProfiles();
  const action = useRun();
  const [profile, setProfile] = useState<string>();
  const [method, setMethod] = useState('GET');
  const [target, setTarget] = useState('');
  const [targetPreview, setTargetPreview] = useState<{ method: string; url: string; draft: string }>();
  const draftSequence = useRef(0);
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
  const [importToken, setImportToken] = useState<string>();
  const [service, setService] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const draftKey = JSON.stringify([method, target, operationId, query, headers, body, inputs, timeout, profile]);
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
    pane.reveal();
    const sequence = ++draftSequence.current;
    void safely(async () => {
      const draft = await command<HttpRequest>('api draft', { id: entity.id });
      if (sequence === draftSequence.current) update(draft);
    });
  }
  return (
    <div className="split detail-split">
      <div ref={pane.listRef} className="stack list-anchor" tabIndex={-1}>
        <div className="toolbar">
          <Button
            onClick={() => {
              draftSequence.current++;
              list.setSelected('');
              update({ method: 'GET' });
              pane.reveal();
            }}
          >
            {t('manual')}
          </Button>
          <Button onClick={() => setImporting(true)}>{t('importApi')}</Button>
        </div>
        <CatalogList list={list} choose={choose} />
      </div>
      <div ref={pane.detailRef} className="stack list-detail" tabIndex={-1}>
        <BackToList onClick={pane.back} />
        {list.detail.data && <EntityDetail entity={list.detail.data} />}
        {list.selected && (
          <Space wrap>
            {['json', 'yaml'].map((format) => (
              <Button
                key={format}
                onClick={() =>
                  void safely(async () => {
                    const data = await command<{ text: string }>('api export', { id: list.selected, format });
                    await download('openapi.' + format, data.text);
                  })
                }
              >
                {t(format === 'json' ? 'export' : 'exportYaml')}
              </Button>
            ))}
          </Space>
        )}
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
            <Space wrap className="request-actions">
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
                    const preview = await command<{ method: string; url: string }>('api preview', {
                      body: request(),
                      profile,
                    });
                    setTargetPreview({ ...preview, draft: draftKey });
                  })
                }
              >
                {t('previewTarget')}
              </Button>
              <Button
                onClick={() =>
                  void safely(async () => {
                    const data = await command<{ curl: string }>('api curl', { body: request(), profile });
                    await copyText(data.curl);
                    notify(t('copied'));
                  })
                }
              >
                {t('curl')}
              </Button>
              <Button onClick={() => setSaving(true)}>{t('saveCase')}</Button>
            </Space>
            {targetPreview?.draft === draftKey && <Code value={targetPreview.method + ' ' + targetPreview.url} />}
            <div className="split split-even">
              <RequestPairs kind="query" value={query} change={setQuery} />
              <RequestPairs kind="header" value={headers} change={setHeaders} />
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
            await command('api import', {
              [importType]: importPath,
              fileToken: importToken,
              profile,
              service: service || undefined,
            });
            refresh();
            setImporting(false);
          }).finally(() => setImportBusy(false));
        }}
      >
        <div className="stack">
          <ErrorView error={error} />
          <Select
            value={importType}
            virtual={false}
            onChange={(type) => {
              setImportType(type);
              setImportToken(undefined);
              setImportPath('');
            }}
            options={[
              { value: 'file', label: t('file') },
              { value: 'url', label: t('url') },
            ]}
          />
          <Field label={t(importType)}>
            <div className="toolbar">
              <Input
                className="grow"
                value={importPath}
                readOnly={!!importToken}
                onChange={(event) => setImportPath(event.target.value)}
              />
              {projectId && importType === 'file' && (
                <Button
                  onClick={() =>
                    void safely(async () => {
                      const picked = await unwrap(window.ifaceforge!.chooseFile(projectId, 'openapi'));
                      if (picked) {
                        setImportPath(picked.path);
                        setImportToken(picked.token);
                      }
                    })
                  }
                >
                  {lang === 'zh-CN' ? '选择文件' : 'Choose file'}
                </Button>
              )}
            </div>
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

function RequestPairs({
  kind,
  value,
  change,
}: {
  kind: 'query' | 'header';
  value: string;
  change: (next: string) => void;
}) {
  const { lang, t } = useWorkspace();
  const zh = lang === 'zh-CN';
  const label = kind === 'query' ? (zh ? '查询参数' : 'Query parameters') : zh ? '请求头' : 'Headers';
  let pairs: Pair[] | undefined;
  try {
    const parsed = parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => entry && typeof entry.name === 'string' && 'value' in entry)
    ) {
      pairs = parsed as Pair[];
    }
  } catch {
    // The JSON editor stays available while someone is repairing a draft.
  }
  const update = (index: number, fields: Partial<Pair>) =>
    change(json(pairs?.map((pair, at) => (at === index ? { ...pair, ...fields } : pair)) ?? []));
  return (
    <div className="request-pairs">
      {pairs && (
        <>
          <Typography.Text strong>{label}</Typography.Text>
          {pairs.map((pair, index) => (
            <div className="pair-fields" key={index}>
              <Input
                aria-label={label + ' ' + t('name') + ' ' + (index + 1)}
                placeholder={t('name')}
                value={pair.name}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <Input
                aria-label={label + ' ' + (zh ? '值' : 'value') + ' ' + (index + 1)}
                placeholder={zh ? '值' : 'Value'}
                value={typeof pair.value === 'object' ? json(pair.value) : String(pair.value)}
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <Button
                aria-label={t('remove') + ' ' + label + ' ' + (index + 1)}
                onClick={() => change(json(pairs?.filter((_entry, at) => at !== index)))}
              >
                {t('remove')}
              </Button>
            </div>
          ))}
          <Button size="small" onClick={() => change(json([...pairs!, { name: '', value: '' }]))}>
            {kind === 'query' ? (zh ? '添加参数' : 'Add parameter') : zh ? '添加请求头' : 'Add header'}
          </Button>
        </>
      )}
      <details open={pairs ? undefined : true}>
        <summary>{t(kind)}</summary>
        <JsonField label={t(kind)} value={value} change={change} rows={3} />
      </details>
    </div>
  );
}
