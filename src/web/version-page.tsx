import { Alert, Button, Card, Input, Popover, Progress, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { GitCommit, GitFile, GitRef } from '../app/git-history.js';
import { commitLanes } from '../app/git-graph.js';
import type { BrowseVersion, VersionMode, VersionReport } from '../app/version-compare.js';
import type { VersionTask } from '../desktop/protocol.js';
import { download } from './client.js';
import { BackToList, Code, ErrorView, useLoad, useSplitView, useWorkspace, type Listed } from './components.js';
import './version.css';

type Command = ReturnType<typeof useWorkspace>['command'];
type History = {
  heads: string[];
  items: GitCommit[];
  more: boolean;
  offset: number;
  limit: number;
  requested?: string;
};
type Match = { name: string; key: string; children: { value: string; label: string }[] };
const running = (task?: VersionTask) => task?.state === 'running' || task?.state === 'cancelling';
const short = (sha?: string) => sha?.slice(0, 8) ?? '';

function useText() {
  const { lang } = useWorkspace();
  return (en: string, cn: string) => (lang === 'zh-CN' ? cn : en);
}

export function useVersions(command: Command, desktop: boolean, visible: boolean) {
  const [refRevision, setRefRevision] = useState(0);
  const [view, setView] = useState<BrowseVersion | null>(null);
  const [base, setBase] = useState<string>();
  const [target, setTarget] = useState<string>();
  const [mode, setMode] = useState<VersionMode>('branches');
  const [ancestor, setAncestor] = useState<string>();
  const [scope, setScope] = useState('all');
  const [visibility, setVisibility] = useState(false);
  const [error, setError] = useState<unknown>();
  const [task, setTask] = useState<VersionTask>();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<VersionReport>();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const initialized = useRef(false);
  const refs = useLoad(async () => {
    const items: GitRef[] = [];
    let page: Listed<GitRef>;
    do {
      page = await command<Listed<GitRef>>('git branches', { limit: 500, offset: items.length });
      items.push(...page.items);
    } while (page.items.length && items.length < page.total);
    return items;
  }, [command, refRevision]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      command<BrowseVersion | null>('git view'),
      command<{ base?: string; target?: string; mode?: VersionMode; ancestor?: string } | null>('git preference'),
    ])
      .then(([stored, selection]) => {
        if (!mounted) return;
        setView(stored);
        setMode(selection?.mode ?? 'branches');
        setBase(selection?.base);
        setTarget(selection?.target);
        setAncestor(selection?.ancestor);
        initialized.current = true;
      })
      .catch(setError);
    return () => {
      mounted = false;
    };
  }, [command]);

  useEffect(() => {
    if (!visible || busy) return;
    let mounted = true;
    const timer = setInterval(() => {
      void command<BrowseVersion | null>('git view')
        .then((next) => {
          if (mounted)
            setView((previous) =>
              previous?.snapshot === next?.snapshot && previous?.ref === next?.ref ? previous : next,
            );
        })
        .catch(() => undefined);
    }, 2200);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [command, visible, busy]);

  useEffect(() => {
    if (!initialized.current || !visibility) return;
    void command('git preference', { base, target, mode, ancestor }).catch(setError);
  }, [command, mode, base, target, ancestor, visibility]);

  function receive(next: VersionTask) {
    setTask(next);
    if (!running(next)) setBusy(false);
    if (next.state === 'complete') {
      if (next.operation === 'compare') setReport(next.result as VersionReport);
      else setView(next.result as BrowseVersion);
    }
    if (next.state === 'failed') setError(next.error);
  }

  useEffect(() => {
    if (!desktop || !running(task)) return;
    let mounted = true;
    const poll = () =>
      void command<VersionTask>('git task', { id: task!.id })
        .then((next) => {
          if (!mounted) return;
          receive(next);
        })
        .catch((failure) => {
          if (mounted) {
            setBusy(false);
            setTask(undefined);
            setError(failure);
          }
        });
    const interval = setInterval(poll, 350);
    poll();
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [command, task?.id, task?.state, desktop]);

  async function start(operation: 'compare' | 'git browse', ref?: string) {
    if (busy) return;
    setError(undefined);
    setBusy(true);
    setTask(undefined);
    try {
      if (operation === 'git browse' && !ref) {
        await command('git browse');
        setView(null);
        setBusy(false);
        return;
      }
      const input = operation === 'compare' ? { base, target, mode, ancestor } : { ref };
      if (desktop) receive(await command<VersionTask>(operation, input));
      else {
        if (operation === 'compare') setReport(await command<VersionReport>(operation, input));
        else setView(await command<BrowseVersion>(operation, input));
        setBusy(false);
      }
    } catch (failure) {
      setBusy(false);
      setError(failure);
    }
  }

  function selectMode(next: VersionMode) {
    setMode(next);
    if (next === 'branches') {
      const match = (ref?: string) =>
        refs.data?.find((item) => item.ref === ref || (item.sha === ref && item.kind !== 'tag'))?.ref;
      setBase(match(base));
      setTarget(match(target));
    }
  }

  function changeEndpoint(side: 'base' | 'target', ref?: string) {
    setAncestor(undefined);
    (side === 'base' ? setBase : setTarget)(ref);
  }

  function pick(side: 'base' | 'target', sha: string) {
    setMode('commits');
    changeEndpoint(side, sha);
  }
  return {
    refs,
    view,
    base,
    target,
    changeEndpoint,
    mode,
    selectMode,
    ancestor,
    setAncestor,
    scope,
    setScope,
    visibility,
    setVisibility,
    error,
    task,
    busy,
    report,
    start,
    commits,
    setCommits,
    pick,
    refreshRefs: () => setRefRevision((value) => value + 1),
    cancel: () => task && void command<VersionTask>('git cancel', { id: task.id }).then(receive).catch(setError),
  };
}
type Versions = ReturnType<typeof useVersions>;

function groupRefs(refs: GitRef[], text: ReturnType<typeof useText>) {
  const groups: Match[] = [
    { name: text('Local branches', '本地分支'), key: 'local', children: [] },
    { name: text('Remote branches', '远程分支'), key: 'remote', children: [] },
    { name: text('Tags', '标签'), key: 'tag', children: [] },
  ];
  for (const ref of refs)
    groups
      .find((group) => group.key === ref.kind)!
      .children.push({
        value: ref.ref,
        label: ref.name + ' · ' + short(ref.sha) + (ref.current ? ' · HEAD' : ''),
      });
  return groups
    .filter((group) => group.children.length)
    .map((group) => ({ label: group.name, options: group.children }));
}

export function VersionBar({ state, open }: { state: Versions; open: () => void }) {
  const text = useText();
  const options = groupRefs(state.refs.data ?? [], text);
  const reference = state.refs.data?.find((ref) => ref.ref === state.view?.ref);
  const moved = reference && state.view && reference.sha !== state.view.sha;
  const [baseEdited, setBaseEdited] = useState(false);
  const [targetEdited, setTargetEdited] = useState(false);
  const task = state.task;
  const percent =
    task?.total === undefined ? undefined : Math.round((100 * task.processed) / Math.max(1, task.total));
  const progress = (
    <div className="version-progress" role="status">
      <Typography.Text strong>
        {task?.operation === 'git browse'
          ? text('Reading committed files', '正在扫描提交文件')
          : text('Comparing versions', '正在比较版本')}
      </Typography.Text>
      {task?.phase && (
        <Typography.Text type="secondary">
          {task.phase === 'base' ? text('Scanning base', '正在扫描基准') : text('Scanning target', '正在扫描目标')}
        </Typography.Text>
      )}
      {percent !== undefined && (
        <Progress
          size="small"
          percent={task?.phase ? Math.round(percent / 2) + (task.phase === 'target' ? 50 : 0) : percent}
        />
      )}
      {task && (
        <Button size="small" disabled={task.state === 'cancelling'} onClick={state.cancel}>
          {text('Cancel scan', '取消扫描')}
        </Button>
      )}
    </div>
  );

  const endpoint = (side: 'base' | 'target') => {
    const value = state[side];
    const label = side === 'base' ? text('Base', '基准') : text('Target', '目标');
    const change = (ref: string) => state.changeEndpoint(side, ref);
    if (state.mode === 'branches')
      return (
        <Select
          aria-label={label}
          placeholder={label}
          value={value}
          onChange={change}
          disabled={state.busy}
          showSearch={{ optionFilterProp: 'label' }}
          options={options.filter((group) => group.label !== text('Tags', '标签'))}
        />
      );
    const edited = side === 'base' ? baseEdited : targetEdited;
    const setEdited = side === 'base' ? setBaseEdited : setTargetEdited;
    return (
      <div className="version-endpoint">
        {edited ? (
          <Input
            aria-label={label}
            placeholder={text('Commit SHA or ref', '提交 SHA 或引用')}
            value={value}
            disabled={state.busy}
            onChange={(event) => change(event.target.value)}
          />
        ) : (
          <Select
            aria-label={label}
            placeholder={label}
            value={value}
            onChange={change}
            disabled={state.busy}
            showSearch={{ optionFilterProp: 'label' }}
            options={[
              ...state.commits.map((commit) => ({
                value: commit.sha,
                label: short(commit.sha) + ' · ' + commit.title,
              })),
              ...(!value || state.commits.some((item) => item.sha === value) ? [] : [{ value, label: value }]),
            ]}
          />
        )}
        <Button type="text" size="small" onClick={() => setEdited(!edited)}>
          {edited ? text('List', '列表') : 'SHA'}
        </Button>
      </div>
    );
  };

  return (
    <div className="version-tools">
      <div className="version-browse">
        <Select
          aria-label={text('Browse version', '浏览版本')}
          value={state.view?.ref ?? ''}
          disabled={state.busy}
          showSearch={{ optionFilterProp: 'label' }}
          onChange={(ref) => void state.start('git browse', ref)}
          options={[{ value: '', label: text('Working tree', '当前工作区') }, ...options]}
        />
        {state.view && <Tag title={state.view.sha}>{short(state.view.sha)}</Tag>}
        {moved && (
          <Button size="small" onClick={() => void state.start('git browse', reference.ref)} disabled={state.busy}>
            {text('Load new tip', '查看最新提交')}
          </Button>
        )}
        <Button onClick={state.refreshRefs}>{text('Refresh refs', '刷新引用')}</Button>
        <Popover open={state.busy} arrow={false} placement="bottomLeft" content={progress} destroyOnHidden>
          <Button onClick={open}>{text('Versions and comparison', '版本与对比')}</Button>
        </Popover>
      </div>
      {state.visibility && (
        <div className="version-range">
          <Select
            aria-label={text('Comparison mode', '比较类型')}
            value={state.mode}
            onChange={state.selectMode}
            disabled={state.busy}
            options={[
              { value: 'branches', label: text('Compare branches', '分支对比') },
              { value: 'commits', label: text('Compare commits', '提交对比') },
            ]}
          />
          {endpoint('base')}
          {endpoint('target')}
          <Button
            disabled={state.busy || !state.base || !state.target}
            onClick={() => {
              state.changeEndpoint('base', state.target);
              state.changeEndpoint('target', state.base);
            }}
          >
            {text('Swap', '交换')}
          </Button>
          <Button
            type="primary"
            disabled={!state.base || !state.target}
            loading={state.busy}
            onClick={() => {
              open();
              void state.start('compare');
            }}
          >
            {text('Compare', '比较')}
          </Button>
        </div>
      )}
      <ErrorView error={state.error || state.refs.error} />
      {state.view?.complete === false && (
        <Alert type="warning" title={text('Partial version scan', '版本扫描结果不完整')} />
      )}
    </div>
  );
}

const colors = ['#3166ad', '#7350aa', '#297869', '#a26325', '#aa4d72', '#327a93', '#805d43'];

function usePreview() {
  const [preview, set] = useState<{
    commit: GitCommit;
    x: number;
    y: number;
    dx: number;
    dy: number;
    closing?: boolean;
  }>();
  const point = useRef({ x: 0, y: 0 });
  const frame = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = () => {
    clearTimeout(timer.current);
    set((value) => value && { ...value, closing: true });
    timer.current = setTimeout(() => set(undefined), 120);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      clearTimeout(timer.current);
      cancelAnimationFrame(frame.current);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);
  const bind = (commit: GitCommit) => ({
    onPointerEnter(event: PointerEvent) {
      if (event.pointerType === 'touch') return;
      clearTimeout(timer.current);
      point.current = { x: event.clientX, y: event.clientY };
      set((value) => (value?.commit.sha === commit.sha ? value : undefined));
      timer.current = setTimeout(() => set({ commit, ...point.current, dx: 0, dy: 0 }), 230);
    },
    onPointerMove(event: PointerEvent) {
      point.current = { x: event.clientX, y: event.clientY };
      if (!preview || preview.closing || preview.commit.sha !== commit.sha || frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const drift = (movement: number) => Math.max(-22, Math.min(22, movement * 0.28));
        set(
          (value) =>
            value && { ...value, dx: drift(point.current.x - value.x), dy: drift(point.current.y - value.y) },
        );
      });
    },
    onPointerLeave: hide,
    onPointerDown: hide,
  });
  return { preview, bind };
}

function CommitGraph({
  state,
  focused,
  setFocused,
  selectCommit,
}: {
  state: Versions;
  focused?: GitCommit;
  setFocused: (value: GitCommit) => void;
  selectCommit: (value: GitCommit) => void;
}) {
  const { command, project } = useWorkspace();
  const text = useText();
  const refs = state.refs.data ?? [];
  const [extra, setExtra] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>();
  const [needle, setNeedle] = useState('');
  const [refLimit, setRefLimit] = useState(24);
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<History>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [selectedRef, setSelectedRef] = useState<string>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const rowRegion = useRef<HTMLDivElement>(null);
  const { preview, bind } = usePreview();

  const active = refs.find((ref) => ref.current);
  const input = [
    active?.sha,
    state.view?.sha,
    state.report?.base.sha,
    state.report?.target.sha,
    ...extra.map((ref) => refs.find((item) => item.ref === ref)?.sha),
  ].filter((ref): ref is string => !!ref);
  const signature = [...new Set(input)].sort().join(' ');
  const historyRequest = useLoad(
    async () => ({
      ...(await command<History>('git log', { refs: signature ? signature.split(' ') : [], limit: 24 })),
      requested: signature,
    }),
    [command, signature],
  );
  useEffect(() => {
    if (!historyRequest.loading && historyRequest.data) {
      setHistory(historyRequest.data);
      const first = historyRequest.data.items[0];
      if (!focused && first) setFocused(first);
    }
  }, [historyRequest.data, historyRequest.loading]);
  useEffect(() => {
    if (history) state.setCommits(history.items);
  }, [history]);

  const items = useMemo(() => commitLanes(history?.items ?? []), [history]);
  const refLabels = useMemo(() => {
    const values = new Map<string, GitRef[]>();
    for (const ref of refs) {
      const labels = values.get(ref.sha) ?? [];
      if (ref.current || ref.ref === selectedRef) labels.unshift(ref);
      else labels.push(ref);
      values.set(ref.sha, labels);
    }
    return values;
  }, [refs, selectedRef]);
  const matchingRefs = refs.filter(
    (ref) => (!filter || filter === ref.kind) && ref.name.toLowerCase().includes(needle.toLowerCase()),
  );
  const marker = (sha: string) => {
    const report = state.report;
    if (!report) return null;
    if (sha === report.base.sha && sha === report.target.sha)
      return <Tag color="blue">{text('Base and target', '基准与目标')}</Tag>;
    if (sha === report.base.sha) return <Tag color="gold">{text('Base', '基准')}</Tag>;
    if (sha === report.target.sha) return <Tag color="blue">{text('Target', '目标')}</Tag>;
    if (report.relation.common.includes(sha))
      return <Tag color="green">{text('Common ancestor', '共同祖先')}</Tag>;
    if (report.relation.baseOnly.includes(sha)) return <Tag color="gold">{text('Base only', '基准独有')}</Tag>;
    if (report.relation.targetOnly.includes(sha)) return <Tag color="blue">{text('Target only', '目标独有')}</Tag>;
    return null;
  };

  useEffect(() => {
    const node = canvas.current,
      rows = rowRegion.current;
    if (!node || !rows || !items.length) return;
    const draw = () => {
      const width = node.clientWidth,
        height = rows.offsetHeight,
        pixel = window.devicePixelRatio || 1;
      node.width = width * pixel;
      node.height = height * pixel;
      const ctx = node.getContext('2d')!;
      ctx.scale(pixel, pixel);
      ctx.lineWidth = 1.65;
      const indexed = new Map(
        items.map((item, i) => [
          item.sha,
          { item, y: (rows.children[i] as HTMLElement).offsetTop + rows.children[i].clientHeight / 2 },
        ]),
      );
      const highlight = new Set<string>();
      const start = refs.find((ref) => ref.ref === selectedRef)?.sha;
      const pending = start ? [start] : [];
      while (pending.length) {
        const sha = pending.pop()!;
        if (highlight.has(sha)) continue;
        highlight.add(sha);
        pending.push(...(indexed.get(sha)?.item.parents ?? []));
      }
      const maxLane = Math.max(...items.flatMap((item) => [item.lane, ...item.edges.map((edge) => edge.lane)]));
      const x = (lane: number) => 12 + lane * Math.min(17, (width - 24) / Math.max(1, maxLane));
      for (const entry of indexed.values()) {
        const startX = x(entry.item.lane);
        for (const edge of entry.item.edges) {
          const target = indexed.get(edge.parent);
          const endX = x(target?.item.lane ?? edge.lane),
            bottom = target?.y ?? height;
          ctx.setLineDash(target ? [] : [3, 4]);
          ctx.strokeStyle = colors[edge.lane % colors.length];
          ctx.globalAlpha = start && !highlight.has(entry.item.sha) ? 0.25 : 0.9;
          ctx.beginPath();
          ctx.moveTo(startX, entry.y);
          ctx.bezierCurveTo(startX, entry.y + 18, endX, Math.max(entry.y, bottom - 18), endX, bottom);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      for (const { item, y } of indexed.values()) {
        const cx = x(item.lane);
        ctx.fillStyle = focused?.sha === item.sha ? colors[item.lane % colors.length] : '#fff';
        ctx.strokeStyle = colors[item.lane % colors.length];
        ctx.beginPath();
        if (item.parents.length > 1) {
          ctx.moveTo(cx, y - 5);
          ctx.lineTo(cx + 5, y);
          ctx.lineTo(cx, y + 5);
          ctx.lineTo(cx - 5, y);
          ctx.closePath();
        } else ctx.arc(cx, y, state.report?.relation.common.includes(item.sha) ? 6 : 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(rows);
    draw();
    return () => observer.disconnect();
  }, [items, focused?.sha, selectedRef, refs, state.report?.relation.common]);

  async function more() {
    if (!history?.more || loadingMore || history.requested !== signature || historyRequest.loading) return;
    setLoadingMore(true);
    setFailure(undefined);
    try {
      const next = await command<History>('git log', {
        refs: history.heads,
        offset: history.items.length,
        limit: history.limit,
      });
      setHistory((current) =>
        current === history
          ? { ...next, requested: history.requested, items: [...history.items, ...next.items] }
          : current,
      );
    } catch (error) {
      setFailure(error);
    } finally {
      setLoadingMore(false);
    }
  }

  async function locate(revision: string) {
    setFailure(undefined);
    const bySha = /^[\da-f]{4,64}$/i.test(revision);
    const listed =
      items.find((commit) => !bySha && commit.title.toLowerCase() === revision.toLowerCase()) ??
      items.find((commit) =>
        bySha
          ? commit.sha.startsWith(revision.toLowerCase())
          : commit.title.toLowerCase().includes(revision.toLowerCase()),
      );
    try {
      const commit =
        listed ??
        (bySha
          ? await command<GitCommit>('git commit', { ref: revision })
          : (await command<History>('git log', { refs: history?.heads, limit: 1, query: revision })).items[0]);
      if (!commit) throw new Error(text('No matching commit in the selected history', '所选历史中没有匹配的提交'));
      setFocused(commit);
      rowRegion.current?.querySelector('[data-commit="' + commit.sha + '"]')?.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <Card
      size="small"
      title={text('Git network', 'Git 提交网络图')}
      extra={
        <Typography.Text type="secondary">
          {items.length} {text('commits', '个提交')}
        </Typography.Text>
      }
    >
      <div className="stack git-graph-controls">
        <Space wrap>
          <Tag>○ {text('Commit', '提交')}</Tag>
          <Tag>◇ {text('Merge', '合并')}</Tag>
          <Tag color="green">{text('Common ancestor', '共同祖先')}</Tag>
          <Tag>╌ {text('Older history', '更早历史')}</Tag>
        </Space>
        <Select
          mode="multiple"
          maxCount={32}
          maxTagCount="responsive"
          value={extra}
          onChange={(values) => {
            setExtra(values);
            setSelectedRef(values.at(-1));
          }}
          aria-label={text('Branches in graph', '图中显示的分支')}
          placeholder={text('Show branches in graph', '选择要显示的分支')}
          options={groupRefs(refs, text)}
          showSearch={{ optionFilterProp: 'label' }}
        />
        <details>
          <summary>
            {text('All refs', '全部引用')} · {refs.length}
          </summary>
          <Space wrap className="git-ref-filters">
            <Input
              aria-label={text('Find a branch', '搜索分支')}
              placeholder={text('Filter branches', '搜索分支')}
              value={needle}
              onChange={(event) => {
                setNeedle(event.target.value);
                setRefLimit(24);
              }}
            />
            <Select
              aria-label={text('Ref type', '引用类型')}
              allowClear
              value={filter}
              onChange={(value) => {
                setFilter(value);
                setRefLimit(24);
              }}
              placeholder={text('All types', '全部类型')}
              options={[
                { value: 'local', label: text('Local', '本地') },
                { value: 'remote', label: text('Remote', '远程') },
                { value: 'tag', label: text('Tags', '标签') },
              ]}
            />
          </Space>
          <div className="git-ref-list">
            {matchingRefs.slice(0, refLimit).map((ref) => (
              <Button
                key={ref.ref}
                disabled={extra.length >= 32 && !extra.includes(ref.ref)}
                onClick={() => {
                  setSelectedRef(ref.ref);
                  setExtra((value) => (value.includes(ref.ref) ? value : [...value, ref.ref]));
                  void locate(ref.sha);
                }}
              >
                {ref.name}
                {ref.current ? ' · HEAD' : ''}
              </Button>
            ))}
          </div>
          {matchingRefs.length > refLimit && (
            <Button size="small" onClick={() => setRefLimit((value) => value + 24)}>
              {text('Show more refs', '显示更多引用')}
            </Button>
          )}
        </details>
        <Input.Search
          aria-label={text('Find commit', '定位提交')}
          placeholder={text('Title or SHA', '标题或 SHA')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onSearch={(value) => {
            if (value.trim()) void locate(value.trim());
          }}
        />
        <ErrorView error={failure || historyRequest.error} />
        <div className="git-history-viewport">
          <div className="git-history">
            <canvas ref={canvas} aria-hidden="true" />
            <div ref={rowRegion} className="git-rows">
              {items.map((item) => (
                <button
                  type="button"
                  className="git-row"
                  data-commit={item.sha}
                  key={item.sha}
                  aria-pressed={focused?.sha === item.sha}
                  onClick={() => selectCommit(item)}
                  {...bind(item)}
                >
                  <span className="git-row-main">
                    <strong>{item.title || short(item.sha)}</strong>
                    <span className="git-ref-tags">
                      <code>{short(item.sha)}</code>
                      {(refLabels.get(item.sha) ?? []).slice(0, 3).map((ref) => (
                        <Tag
                          color={ref.kind === 'tag' ? 'purple' : ref.kind === 'remote' ? 'cyan' : 'blue'}
                          key={ref.ref}
                        >
                          {ref.name}
                          {ref.current ? ' · HEAD' : ''}
                        </Tag>
                      ))}
                      {(refLabels.get(item.sha)?.length ?? 0) > 3 && (
                        <Tag>+{refLabels.get(item.sha)!.length - 3}</Tag>
                      )}
                      {item.parents.length > 1 && <Tag>{text('Merge', '合并')}</Tag>}
                    </span>
                  </span>
                  <span className="git-row-meta">
                    <time dateTime={item.date}>{item.date.slice(5, 16).replace('T', ' ')}</time>
                    {marker(item.sha)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="git-history-footer">
          <Typography.Text type="secondary">
            {history?.more
              ? text('Older commits are available', '还有更早的提交')
              : items.length
                ? text('End of available history', '已显示可用历史')
                : text('No commits to display', '没有可显示的提交')}
          </Typography.Text>
          {history?.more && (
            <Button
              loading={loadingMore || historyRequest.loading}
              disabled={history.requested !== signature || historyRequest.loading}
              onClick={() => void more()}
            >
              {text('Show more', '显示更多')}
            </Button>
          )}
        </div>
        {project.branch && state.report?.relation.shallow && (
          <Alert type="info" title={text('This is a shallow clone', '当前为浅克隆')} />
        )}
      </div>
      {preview && <CommitTooltip {...preview} />}
    </Card>
  );
}

function CommitTooltip({
  commit,
  x,
  y,
  dx,
  dy,
  closing,
}: {
  commit: GitCommit;
  x: number;
  y: number;
  dx: number;
  dy: number;
  closing?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current!;
    const { offsetWidth: width, offsetHeight: height } = node;
    const left = Math.min(
      innerWidth - width - 10,
      Math.max(10, (x + width + 20 < innerWidth ? x + 20 : x - width - 20) + dx),
    );
    const top = Math.min(
      innerHeight - height - 10,
      Math.max(10, (y + height + 20 < innerHeight ? y + 20 : y - height - 20) + dy),
    );
    node.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0)';
    node.dataset.positioned = 'true';
  }, [x, y, dx, dy]);
  return (
    <div className="git-tooltip" role="tooltip" data-closing={closing} ref={ref}>
      <div>
        <strong>{commit.title}</strong>
        <code>{short(commit.sha)}</code>
      </div>
      <small>
        {commit.author} · {commit.date.replace('T', ' ')}
      </small>
      {commit.message && <p>{commit.message}</p>}
    </div>
  );
}

function CommitDetails({
  commit,
  select,
  state,
}: {
  commit?: GitCommit;
  select: (item: GitCommit) => void;
  state: Versions;
}) {
  const text = useText();
  const { command } = useWorkspace();
  const [error, setError] = useState<unknown>();
  const { preview, bind } = usePreview();
  if (!commit) return null;
  return (
    <Card size="small" title={text('Commit details', '提交详情')} className="git-details">
      <div className="stack">
        <div {...bind(commit)}>
          <strong>{commit.title}</strong>
        </div>
        <dl>
          <dt>SHA</dt>
          <dd>
            <Typography.Text copyable>{commit.sha}</Typography.Text>
          </dd>
          <dt>{text('Author', '作者')}</dt>
          <dd>{commit.author}</dd>
          <dt>{text('Commit time', '提交时间')}</dt>
          <dd>
            <time dateTime={commit.date}>{commit.date.replace('T', ' ')}</time>
          </dd>
          <dt>{text('Parents', '父提交')}</dt>
          <dd>
            <Space wrap>
              {commit.parents.map((sha) => (
                <Button
                  key={sha}
                  size="small"
                  onClick={() => void command<GitCommit>('git commit', { ref: sha }).then(select).catch(setError)}
                >
                  {short(sha)}
                </Button>
              ))}
            </Space>
          </dd>
        </dl>
        {commit.message && (
          <details>
            <summary>{text('Show full message', '显示完整说明')}</summary>
            <p className="git-message">{commit.message}</p>
          </details>
        )}
        <ErrorView error={error} />
        <Space wrap>
          <Button disabled={state.busy} onClick={() => state.pick('base', commit.sha)}>
            {text('Set as base', '设为基准')}
          </Button>
          <Button type="primary" disabled={state.busy} onClick={() => state.pick('target', commit.sha)}>
            {text('Set as target', '设为目标')}
          </Button>
          <Button disabled={state.busy} onClick={() => void state.start('git browse', commit.sha)}>
            {text('Browse this commit', '浏览此提交')}
          </Button>
        </Space>
      </div>
      {preview && <CommitTooltip {...preview} />}
    </Card>
  );
}

const scopes = ['all', 'api', 'mcp', 'skill', 'files', 'diagnostics'];
function stringify(value: unknown) {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

function FileChanges({ report }: { report: VersionReport }) {
  const { command, showSource } = useWorkspace();
  const text = useText();
  const [file, setFile] = useState<GitFile>();
  const patch = useLoad(
    () =>
      file
        ? command<{ text: string; binary: boolean; truncated: boolean }>('compare file', {
            base: report.effectiveBase,
            target: report.target.sha,
            path: file.path,
            previous: file.previous,
          })
        : Promise.resolve(undefined),
    [command, report.effectiveBase, report.target.sha, file?.path],
  );
  return (
    <div className="stack">
      <Select
        aria-label={text('Changed file', '变更文件')}
        placeholder={text('Select file', '选择文件')}
        value={file?.path}
        showSearch={{ optionFilterProp: 'label' }}
        onChange={(value) => setFile(report.files.find((item) => item.path === value))}
        options={report.files.map((item) => ({
          value: item.path,
          label: item.status + ' · ' + (item.previous ? item.previous + ' → ' : '') + item.path,
        }))}
      />
      {file && (
        <>
          <Space wrap>
            {file.status !== 'A' && (
              <Button
                size="small"
                onClick={() => showSource(file.previous ?? file.path, undefined, report.effectiveBase)}
              >
                {text('Base file', '基准文件')}
              </Button>
            )}
            {file.status !== 'D' && (
              <Button size="small" onClick={() => showSource(file.path, undefined, report.target.sha)}>
                {text('Target file', '目标文件')}
              </Button>
            )}
          </Space>
          <ErrorView error={patch.error} />
          {patch.data?.binary && <Alert title={text('Binary file', '二进制文件')} type="info" />}
          {patch.data?.truncated && <Alert title={text('Patch truncated', '差异已截断')} type="warning" />}
          {patch.data?.text && <Code value={patch.data.text} />}
        </>
      )}
    </div>
  );
}

function VersionResults({ state }: { state: Versions }) {
  const text = useText();
  const { showSource } = useWorkspace();
  const report = state.report;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>();
  const [service, setService] = useState<string>();
  const [unified, setUnified] = useState(false);
  const [limit, setLimit] = useState(30);
  const changes = report?.changes ?? [];
  const labels = [
    text('All capabilities', '全部能力'),
    'HTTP API',
    'MCP',
    'Skills',
    text('Files', '文件'),
    text('Diagnostics', '诊断'),
  ];
  const count = (scope: string) =>
    scope === 'all'
      ? changes.length
      : scope === 'files'
        ? (report?.files.length ?? 0)
        : scope === 'diagnostics'
          ? (report?.base.diagnostics.length ?? 0) + (report?.target.diagnostics.length ?? 0)
          : changes.filter((change) => change.kind === scope).length;
  const filtered = changes.filter(
    (change) =>
      (state.scope === 'all' || state.scope === change.kind) &&
      (!status || status === change.status) &&
      (!service || service === change.service) &&
      change.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Card size="small" title={text('Comparison results', '比较结果')}>
      {!report ? (
        <Typography.Text type="secondary">
          {text('Select both endpoints and run a comparison.', '选择基准和目标后运行比较。')}
        </Typography.Text>
      ) : (
        <div className="stack">
          <Code value={short(report.effectiveBase) + ' → ' + short(report.target.sha)} />
          <Space wrap>
            <Tag color="gold">
              {report.relation.left} {text('base only', '基准独有')}
            </Tag>
            <Tag color="blue">
              {report.relation.right} {text('target only', '目标独有')}
            </Tag>
            <Button
              size="small"
              onClick={() =>
                download('ifaceforge-comparison.json', {
                  ...report,
                  filters: { scope: state.scope, query, status, service },
                })
              }
            >
              {text('Export JSON', '导出 JSON')}
            </Button>
          </Space>
          {!report.comparable && <Alert type="warning" title={text('Partial scan results', '部分扫描结果')} />}
          <Space wrap>
            <Select
              aria-label={text('Comparison basis', '对比基准方式')}
              value={state.ancestor ?? 'endpoints'}
              onChange={(value) => state.setAncestor(value === 'endpoints' ? undefined : value)}
              options={[
                { value: 'endpoints', label: text('Endpoints', '分支端点') },
                ...report.relation.common.map((sha) => ({
                  value: sha,
                  label: text('Common ancestor', '共同祖先') + ' · ' + short(sha),
                })),
              ]}
            />
            <Button onClick={() => void state.start('compare')} disabled={state.busy}>
              {text('Apply basis', '应用基准')}
            </Button>
          </Space>
          <Space wrap>
            {scopes.map((scope, i) => (
              <Button
                key={scope}
                size="small"
                type={state.scope === scope ? 'primary' : 'default'}
                aria-pressed={state.scope === scope}
                onClick={() => {
                  state.setScope(scope);
                  setLimit(30);
                }}
              >
                {labels[i]} {count(scope)}
              </Button>
            ))}
          </Space>
          {state.scope === 'files' ? (
            <FileChanges key={report.effectiveBase + ':' + report.target.sha} report={report} />
          ) : state.scope === 'diagnostics' ? (
            <div className="git-definition-grid">
              <Code value={report.base.diagnostics} />
              <Code value={report.target.diagnostics} />
            </div>
          ) : (
            <>
              <div className="toolbar">
                <Input
                  aria-label={text('Filter changes', '筛选变化')}
                  placeholder={text('Filter changes', '筛选变化')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <Select
                  aria-label={text('Change type', '变化类型')}
                  allowClear
                  value={status}
                  onChange={setStatus}
                  placeholder={text('Change type', '变化类型')}
                  options={[
                    { value: 'added', label: text('Added', '新增') },
                    { value: 'changed', label: text('Changed', '修改') },
                    { value: 'removed', label: text('Removed', '删除') },
                  ]}
                />
                <Select
                  aria-label={text('Service', '服务')}
                  allowClear
                  showSearch
                  value={service}
                  onChange={setService}
                  placeholder={text('Service', '服务')}
                  options={[...new Set(changes.map((change) => change.service))].map((value) => ({
                    value,
                    label: value,
                  }))}
                />
                <Button aria-pressed={unified} onClick={() => setUnified(!unified)}>
                  {unified ? text('Side by side', '并排视图') : text('Unified view', '统一视图')}
                </Button>
              </div>
              {!filtered.length && (
                <Typography.Text type="secondary">{text('No changes', '无差异')}</Typography.Text>
              )}
              <div className="git-change-list">
                {filtered.slice(0, limit).map((change) => (
                  <details key={change.id}>
                    <summary>
                      <Tag
                        color={change.status === 'added' ? 'green' : change.status === 'removed' ? 'red' : 'blue'}
                      >
                        {change.status === 'added'
                          ? text('Added', '新增')
                          : change.status === 'removed'
                            ? text('Removed', '删除')
                            : text('Changed', '修改')}
                      </Tag>
                      <span>{change.name}</span>
                    </summary>
                    <Space wrap>
                      {(
                        [
                          ['base', change.before, report.effectiveBase],
                          ['target', change.after, report.target.sha],
                        ] as const
                      ).map(([side, entity, sha]) => {
                        const source = entity?.observations.find((item) => item.path);
                        return (
                          source?.path && (
                            <Button
                              size="small"
                              key={side}
                              onClick={() => showSource(source.path!, source.line, sha)}
                            >
                              {side === 'base'
                                ? text('Base source', '基准源码')
                                : text('Target source', '目标源码')}
                            </Button>
                          )
                        );
                      })}
                    </Space>
                    {unified ? (
                      <Code
                        value={stringify(change.before)
                          .split('\n')
                          .map((line) => '- ' + line)
                          .concat(
                            stringify(change.after)
                              .split('\n')
                              .map((line) => '+ ' + line),
                          )
                          .join('\n')}
                      />
                    ) : (
                      <div className="git-definition-grid">
                        <div>
                          <strong>{text('Base', '基准')}</strong>
                          <Code value={change.before ?? '∅'} />
                        </div>
                        <div>
                          <strong>{text('Target', '目标')}</strong>
                          <Code value={change.after ?? '∅'} />
                        </div>
                      </div>
                    )}
                  </details>
                ))}
                {filtered.length > limit && (
                  <Button onClick={() => setLimit((value) => value + 30)}>{text('Show more', '显示更多')}</Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

export function VersionPage({ state }: { state: Versions }) {
  const [focused, setFocused] = useState<GitCommit>();
  const pane = useSplitView();
  return (
    <div className="git-layout detail-split">
      <div ref={pane.listRef} className="list-anchor" tabIndex={-1}>
        <CommitGraph
          state={state}
          focused={focused}
          setFocused={setFocused}
          selectCommit={(commit) => {
            setFocused(commit);
            pane.reveal(pane.detailRef.current?.querySelector('.git-details'));
          }}
        />
      </div>
      <div ref={pane.detailRef} className="stack list-detail" tabIndex={-1}>
        <VersionResults state={state} />
        <BackToList onClick={pane.back} />
        <CommitDetails commit={focused} select={setFocused} state={state} />
      </div>
    </div>
  );
}
