import { Button, Card, Input, Pagination, Select, Space, Tabs, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { copyText } from './client.js';
import type { Entity, Kind, Observation } from '../scanner/model.js';
import {
  Code,
  EmptyView,
  ErrorView,
  Label,
  Loading,
  Markdown,
  TextButtonList,
  useLoad,
  useWorkspace,
  type Listed,
} from './components.js';

export function useCatalog(kind?: Kind) {
  const { revision, command } = useWorkspace();
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [service, setService] = useState('');
  const [origin, setOrigin] = useState<string>();
  const [state, setState] = useState<string>();
  const [filter, setFilter] = useState<Kind>();
  const [selected, setSelected] = useState('');
  const results = useLoad(
    () =>
      command<Listed<Entity>>('catalog list', {
        kind: kind ?? filter,
        query,
        offset,
        service: service || undefined,
        origin,
        state,
      }),
    [revision, query, offset, filter, kind, service, origin, state],
  );
  const detail = useLoad(
    () => (selected ? command<Entity>('catalog show', { id: selected }) : Promise.resolve(undefined)),
    [selected, revision],
  );
  return {
    query,
    setQuery,
    offset,
    setOffset,
    service,
    setService,
    origin,
    setOrigin,
    state,
    setState,
    filter,
    setFilter,
    selected,
    setSelected,
    results,
    detail,
  };
}

export function CatalogList({
  list,
  expanded = false,
  choose,
}: {
  list: ReturnType<typeof useCatalog>;
  expanded?: boolean;
  choose?: (entity: Entity) => void;
}) {
  const { t } = useWorkspace();
  return (
    <Card size="small">
      <div className="stack">
        <Input.Search
          allowClear
          aria-label={t('search')}
          placeholder={t('search')}
          onSearch={(value) => {
            list.setQuery(value);
            list.setOffset(0);
          }}
        />
        {expanded && (
          <div className="toolbar">
            <Select
              aria-label={t('kind')}
              allowClear
              placeholder={t('kind')}
              value={list.filter}
              onChange={(value) => {
                list.setFilter(value);
                list.setOffset(0);
              }}
              options={(['api', 'mcp', 'skill'] as const).map((value) => ({ value, label: t(value) }))}
            />
            <Select
              aria-label={t('origin')}
              allowClear
              placeholder={t('origin')}
              value={list.origin}
              onChange={(value) => {
                list.setOrigin(value);
                list.setOffset(0);
              }}
              options={(['declaration', 'source', 'runtime'] as const).map((value) => ({
                value,
                label: t(value),
              }))}
            />
            <Select
              aria-label={t('state')}
              allowClear
              placeholder={t('state')}
              value={list.state}
              onChange={(value) => {
                list.setState(value);
                list.setOffset(0);
              }}
              options={(
                [
                  'matched',
                  'MISSING_CONTRACT',
                  'UNVERIFIED_IMPLEMENTATION',
                  'MISSING_RUNTIME',
                  'DEFINITION_CONFLICT',
                ] as const
              ).map((value) => ({ value, label: t(value) }))}
            />
            <Input.Search
              className="grow"
              allowClear
              placeholder={t('service')}
              aria-label={t('service')}
              onSearch={(value) => {
                list.setService(value);
                list.setOffset(0);
              }}
            />
          </div>
        )}
        <ErrorView error={list.results.error} />
        {list.results.loading && !list.results.data ? (
          <Loading />
        ) : (
          <TextButtonList
            items={list.results.data?.items ?? []}
            id={(entity) => entity.id}
            selected={list.selected}
            name={(entity) => (
              <div>
                <strong>{entity.name}</strong>
                <div className="result-source" title={entity.observations[0]?.path}>
                  {entity.service}
                  {entity.observations[0]?.path ? ' · ' + entity.observations[0].path : ''}
                </div>
                <div>
                  <Label value={entity.kind} />
                  {[...new Set(entity.observations.map((item) => item.origin))].map((origin) => (
                    <Label key={origin} value={origin} />
                  ))}
                </div>
              </div>
            )}
            choose={(entity) => {
              list.setSelected(entity.id);
              choose?.(entity);
            }}
          />
        )}
        {(list.results.data?.total ?? 0) > 20 && (
          <Pagination
            size="small"
            current={list.offset / 20 + 1}
            pageSize={20}
            total={list.results.data!.total}
            onChange={(page) => list.setOffset((page - 1) * 20)}
            showSizeChanger={false}
          />
        )}
      </div>
    </Card>
  );
}

function Origins({ observations }: { observations: Observation[] }) {
  const { t, showSource, notify } = useWorkspace();
  return (
    <div className="stack">
      {observations.map((entry, index) => (
        <div key={index} className="stack">
          <Space wrap>
            <Label value={entry.origin} />
            {entry.profile}
            {entry.path && (
              <Typography.Text code>
                {entry.path}
                {entry.line && ':' + entry.line}
              </Typography.Text>
            )}
            {entry.path && (
              <>
                <Button size="small" onClick={() => showSource(entry.path!, entry.line)}>
                  {t('openSource')}
                </Button>
                <Button size="small" onClick={() => void copyText(entry.path!).then(() => notify(t('copied')))}>
                  {t('copyPath')}
                </Button>
              </>
            )}
          </Space>
          <details>
            <summary>{t('definition')}</summary>
            <Code value={entry.definition} />
          </details>
        </div>
      ))}
    </div>
  );
}

export function EntityDetail({ entity }: { entity?: Entity }) {
  const { t, showSource } = useWorkspace();
  if (!entity)
    return (
      <Card>
        <EmptyView select />
      </Card>
    );
  const skill = entity.kind === 'skill' ? entity.observations[0].definition : undefined;
  const refs = skill?.references as { path: string; status: string }[] | undefined;
  return (
    <Card title={entity.name} size="small">
      <div className="stack">
        <Typography.Paragraph>{entity.summary}</Typography.Paragraph>
        <Typography.Text code copyable>
          {entity.id}
        </Typography.Text>
        {entity.differences.length > 0 && (
          <div>
            <strong>{t('differences')}</strong>
            <div>
              {entity.differences.map((value) => (
                <Label key={value} value={value} />
              ))}
            </div>
          </div>
        )}
        <Tabs
          items={[
            ...(skill
              ? [
                  {
                    key: 'markdown',
                    label: t('markdown'),
                    children: <Markdown>{String(skill.body ?? '')}</Markdown>,
                  },
                  { key: 'raw', label: t('raw'), children: <Code value={skill.body} /> },
                  {
                    key: 'references',
                    label: t('references'),
                    children: (
                      <div className="stack">
                        {refs?.length ? (
                          refs.map((item) => (
                            <Space key={item.path} wrap>
                              <Label value={item.status} />
                              <Typography.Text code>{item.path}</Typography.Text>
                              {item.status === 'available' && (
                                <Button onClick={() => showSource(item.path)}>{t('openSource')}</Button>
                              )}
                            </Space>
                          ))
                        ) : (
                          <EmptyView />
                        )}
                      </div>
                    ),
                  },
                ]
              : []),
            { key: 'sources', label: t('sources'), children: <Origins observations={entity.observations} /> },
          ]}
        />
      </div>
    </Card>
  );
}

export function CatalogPage({ kind }: { kind?: Kind }) {
  const list = useCatalog(kind);
  useEffect(() => {
    list.setSelected('');
  }, [kind]);
  return (
    <div className="split">
      <CatalogList list={list} expanded={!kind} />
      <div className="stack">
        <ErrorView error={list.detail.error} />
        <EntityDetail entity={list.detail.data} />
      </div>
    </div>
  );
}
