import {
  App,
  Button,
  ConfigProvider,
  Empty,
  Modal,
  Popover,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import enUS from 'antd/es/locale/en_US.js';
import zhCN from 'antd/es/locale/zh_CN.js';
import type { Locale as AntLocale } from 'antd/es/locale/index.js';
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { scopedCommand, unwrap, type command } from './client.js';
import { translator, type Language } from './i18n.js';
import { ErrorView } from './components.js';
import type { RegisteredProject } from '../storage/projects.js';
import type { DesktopBridge, Result, ScanTask, TaskList, WorkspaceState } from '../desktop/protocol.js';

export interface DesktopContext {
  project: string;
  name: string;
  visible: boolean;
  lang: Language;
  command: typeof command;
  scan?: ScanTask;
  setLocale: (locale: Language) => Promise<void>;
  startScan: () => Promise<void>;
  scanControl: (viewResults: () => void) => ReactNode;
}
const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
const running = (task?: ScanTask) => task?.state === 'running' || task?.state === 'cancelling';
const browserLocale: Language = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

type Candidate = { token: string; selected: string; root: string; relocate?: string };
type ProjectProps = {
  record: RegisteredProject;
  visible: boolean;
  scan?: ScanTask;
  openScan: boolean;
  setOpenScan: (id?: string) => void;
  setLocale: (locale: Language) => Promise<void>;
  startScan: () => Promise<void>;
  cancel: (task: ScanTask) => Promise<void>;
  lang: Language;
  View: ComponentType<{ desktop: DesktopContext }>;
};

function ScanProgress({
  task,
  name,
  lang,
  cancel,
  close,
  retry,
  viewResults,
}: {
  task: ScanTask;
  name: string;
  lang: Language;
  cancel: () => void;
  close: () => void;
  retry: () => void;
  viewResults: () => void;
}) {
  const zh = lang === 'zh-CN';
  const msg = (en: string, cn: string) => (zh ? cn : en);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running(task)) return;
    const timer = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(timer);
  }, [task.id, task.state]);
  const states = {
    enumerating: msg('Enumerating worktree', '正在枚举工作树'),
    processing: msg('Reading files', '正在读取文件'),
    saving: msg('Writing snapshot', '正在保存快照'),
    cancelling: msg('Stopping scan', '正在取消扫描'),
    cancelled: msg('Scan cancelled', '扫描已取消'),
    failed: msg('Scan failed', '扫描失败'),
    complete: task.result?.complete
      ? msg('Scan complete', '扫描完成')
      : msg('Scan completed with warnings', '扫描完成，有警告'),
  };
  const title = running(task) ? msg('Scanning', '正在扫描') : states[task.state as keyof typeof states];
  const elapsed = Math.max(0, ((task.finished ?? now) - task.started) / 1000);
  return (
    <div className="scan-panel" role="status" data-scan-state={task.state}>
      <div className="scan-panel-title">
        <strong>{title}</strong>
        <Button size="small" type="text" aria-label={msg('Close scan status', '收起扫描状态')} onClick={close}>
          ×
        </Button>
      </div>
      <Typography.Text className="scan-project" title={name}>
        {name}
      </Typography.Text>
      <div className="scan-meta">
        {running(task) && <span>{task.state === 'cancelling' ? states.cancelling : states[task.stage]}</span>}
        <span>{elapsed.toFixed(1)} s</span>
      </div>
      {running(task) && task.total === undefined && <div className="scan-indeterminate" />}
      {task.total !== undefined && (
        <Progress
          size="small"
          percent={task.total ? Math.round((task.processed / task.total) * 100) : 100}
          status={task.state === 'failed' ? 'exception' : running(task) ? 'active' : 'normal'}
        />
      )}
      <div className="scan-meta">
        {task.total !== undefined && (
          <span>
            {task.processed} / {task.total}
          </span>
        )}
        <span>
          {task.warnings} {msg('warnings', '条警告')}
        </span>
      </div>
      {task.result && (
        <Typography.Text>
          {task.result.count} {msg(task.result.count === 1 ? 'capability found' : 'capabilities found', '项能力')}
        </Typography.Text>
      )}
      {task.result?.changes && (
        <Typography.Text type="secondary">
          {msg('Added', '新增')} {task.result.changes.added} · {msg('Changed', '变更')}{' '}
          {task.result.changes.changed} · {msg('Removed', '移除')} {task.result.changes.removed}
        </Typography.Text>
      )}
      {task.error && <Typography.Text type="danger">{task.error.message}</Typography.Text>}
      <Space wrap className="scan-actions">
        {running(task) ? (
          <Button size="small" onClick={cancel} disabled={task.state === 'cancelling'}>
            {msg('Cancel scan', '取消扫描')}
          </Button>
        ) : (
          <Button size="small" onClick={retry}>
            {msg('Scan again', '重新扫描')}
          </Button>
        )}
        {task.result?.complete && (
          <Button size="small" onClick={viewResults}>
            {msg('View catalog', '查看目录')}
          </Button>
        )}
        {!running(task) && (
          <Button type="primary" size="small" onClick={close}>
            {msg('Done', '完成')}
          </Button>
        )}
      </Space>
    </div>
  );
}

function ProjectPane({
  record,
  visible,
  scan,
  openScan,
  setOpenScan,
  setLocale,
  startScan,
  cancel,
  lang,
  View,
}: ProjectProps) {
  const command = useMemo(() => scopedCommand(record.id), [record.id]);
  const t = translator(lang);
  const name = projectName(record.root);
  const msg = (en: string, cn: string) => (lang === 'zh-CN' ? cn : en);
  const runButton = (
    <Button type="primary" onClick={() => void startScan()}>
      {t('scan')}
    </Button>
  );
  return (
    <section hidden={!visible}>
      <View
        desktop={{
          project: record.id,
          name,
          visible,
          lang,
          command,
          scan,
          setLocale,
          startScan,
          scanControl: (viewResults) =>
            scan ? (
              <Popover
                open={visible && openScan}
                onOpenChange={(open) => setOpenScan(open ? record.id : undefined)}
                trigger="click"
                placement="bottomRight"
                content={
                  <ScanProgress
                    name={name}
                    task={scan}
                    lang={lang}
                    cancel={() => void cancel(scan)}
                    close={() => setOpenScan(undefined)}
                    retry={() => void startScan()}
                    viewResults={() => {
                      viewResults();
                      setOpenScan(undefined);
                    }}
                  />
                }
              >
                <Button type="primary">{running(scan) ? t('scanning') : msg('Scan status', '扫描状态')}</Button>
              </Popover>
            ) : (
              runButton
            ),
        }}
      />
    </section>
  );
}

export function DesktopApplication({ WorkspaceView }: { WorkspaceView: ProjectProps['View'] }) {
  const bridge = window.ifaceforge as DesktopBridge;
  const { message } = App.useApp();
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  const [tasks, setTasks] = useState<TaskList>({ scans: [], runs: [] });
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const change = useRef(0);
  const changing = useRef(false);
  const [management, setManagement] = useState(false);
  const [settings, setSettings] = useState(false);
  const [taskCenter, setTaskCenter] = useState(false);
  const [openScan, setOpenScan] = useState<string>();
  const [candidate, setCandidate] = useState<Candidate>();
  const [visited, setVisited] = useState<string[]>([]);
  const [removal, setRemoval] = useState<{ project: RegisteredProject; erase: boolean }>();
  const lang = workspace?.locale ?? browserLocale;
  const t = translator(lang);
  const msg = (en: string, cn: string) => (lang === 'zh-CN' ? cn : en);
  const projects = workspace?.projects ?? [];
  const selected = projects.find((item) => item.id === workspace?.selected);
  const available = projects.filter((item) => item.available);
  const activeTasks =
    tasks.scans.filter(running).length +
    (tasks.versions ?? []).filter((item) => item.state === 'running' || item.state === 'cancelling').length +
    tasks.runs.length;
  const taskProjectName = (id: string) => projectName(projects.find((item) => item.id === id)?.root ?? id);

  function accept(data: WorkspaceState) {
    setWorkspace((previous) => (JSON.stringify(previous) === JSON.stringify(data) ? previous : data));
    if (data.selected)
      setVisited((previous) => (previous.includes(data.selected!) ? previous : [...previous, data.selected!]));
  }

  async function update(result: Promise<Result<WorkspaceState>>) {
    const started = ++change.current;
    changing.current = true;
    setError(undefined);
    setPending(true);
    try {
      const data = await unwrap(result);
      if (started === change.current) accept(data);
    } catch (err) {
      setError(err);
      void message.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (started === change.current) {
        changing.current = false;
        setPending(false);
      }
    }
  }
  async function choose(relocate?: string) {
    setError(undefined);
    try {
      const found = await unwrap(bridge.chooseProject());
      if (!found) return;
      if (found.root === found.selected && !relocate) await update(bridge.register(found.token));
      else setCandidate({ ...found, relocate });
    } catch (err) {
      setError(err);
      void message.error(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void update(bridge.state());
    let inFlight = false;
    let lastState = 0;
    let mounted = true;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      const started = change.current;
      const readWorkspace = !changing.current && Date.now() - lastState > 1800;
      if (readWorkspace) lastState = Date.now();
      void Promise.all([unwrap(bridge.tasks()), readWorkspace ? unwrap(bridge.state()) : undefined])
        .then(([next, state]) => {
          if (mounted) setTasks(next);
          if (mounted && state && started === change.current && !changing.current) accept(state);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }, 450);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  function renderScan(scan: ScanTask) {
    setTasks((previous) => ({
      ...previous,
      scans: [...previous.scans.filter((item) => item.project !== scan.project), scan],
    }));
  }
  async function startScan(project: string) {
    setOpenScan(project);
    setError(undefined);
    try {
      renderScan(await scopedCommand(project)<ScanTask>('scan'));
    } catch (err) {
      setError(err);
    }
  }
  async function cancelScan(task: ScanTask) {
    try {
      renderScan(await unwrap(bridge.cancelScan(task.project, task.id)));
    } catch (err) {
      setError(err);
    }
  }
  async function selectProject(id: string, scan = false) {
    setOpenScan(scan ? id : undefined);
    await update(bridge.select(id));
  }

  return (
    <ConfigProvider
      locale={(lang === 'zh-CN' ? zhCN : enUS) as unknown as AntLocale}
      button={{ autoInsertSpace: false }}
      theme={{
        token: {
          colorPrimary: '#245fc4',
          borderRadius: 8,
          fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei UI", sans-serif',
        },
      }}
    >
      <header className="desktop-header">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            {'{ }'}
          </span>{' '}
          IfaceForge
        </div>
        <Select
          virtual={false}
          className="desktop-projects"
          aria-label={msg('Switch project', '切换项目')}
          placeholder={msg('Select a project', '选择项目')}
          value={selected?.id}
          disabled={pending}
          onChange={(id) => void selectProject(id)}
          options={projects
            .filter((item) => !item.hidden)
            .map((item) => ({
              value: item.id,
              label: (
                <span title={item.root}>
                  {projectName(item.root)}
                  {projects.some(
                    (other) => other.id !== item.id && projectName(other.root) === projectName(item.root),
                  )
                    ? ' · ' + item.root
                    : ''}
                  {!item.available && ' · ' + msg('Offline', '离线')}
                </span>
              ),
            }))}
        />
        <div className="desktop-actions">
          <Button onClick={() => void choose()} disabled={pending}>
            {msg('Add project', '添加项目')}
          </Button>
          <Button
            onClick={() => {
              setManagement(true);
              void update(bridge.state());
            }}
          >
            {msg('Manage projects', '管理项目')}
          </Button>
          <Button onClick={() => setTaskCenter(true)}>
            {msg('Tasks', '任务')}
            {activeTasks ? ' · ' + activeTasks : ''}
          </Button>
          <Button onClick={() => setSettings(true)}>{msg('Preferences', '偏好设置')}</Button>
        </div>
      </header>
      {!!error && (
        <div className="desktop-error">
          <ErrorView error={error} />
        </div>
      )}
      {(!selected || !selected.available) && (
        <main className="desktop-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              selected
                ? msg('Project folder is unavailable', '项目目录不可用')
                : msg('Add a Git project to get started', '添加 Git 项目以开始')
            }
          >
            {selected && <Typography.Paragraph className="desktop-path">{selected.root}</Typography.Paragraph>}
            <Button type="primary" disabled={pending} onClick={() => void choose(selected?.id)}>
              {selected ? msg('Locate folder', '重新定位目录') : msg('Add project', '添加项目')}
            </Button>
          </Empty>
        </main>
      )}
      {available
        .filter((item) => visited.includes(item.id) || item.id === selected?.id)
        .map((record) => (
          <ProjectPane
            key={record.id + record.root}
            record={record}
            visible={!record.hidden && record.id === selected?.id}
            View={WorkspaceView}
            lang={lang}
            scan={tasks.scans.find((scan) => scan.project === record.id)}
            openScan={openScan === record.id}
            setOpenScan={setOpenScan}
            setLocale={(locale) => update(bridge.locale(locale))}
            startScan={() => startScan(record.id)}
            cancel={cancelScan}
          />
        ))}
      <Modal
        open={!!candidate}
        title={msg('Confirm Git worktree', '确认 Git 工作树')}
        okText={msg('Use this worktree', '使用此工作树')}
        cancelText={msg('Cancel', '取消')}
        confirmLoading={pending}
        onCancel={() => setCandidate(undefined)}
        onOk={() => {
          if (!candidate) return;
          const { token, relocate } = candidate;
          setCandidate(undefined);
          void update(bridge.register(token, relocate));
        }}
      >
        <Typography.Paragraph className="desktop-path">{candidate?.root}</Typography.Paragraph>
        {candidate?.selected !== candidate?.root && (
          <Typography.Text type="secondary">
            {msg('The folder you selected is inside this worktree.', '你选择的目录位于此工作树内。')}
          </Typography.Text>
        )}
      </Modal>
      <Modal
        open={management}
        title={msg('Manage projects', '管理项目')}
        footer={null}
        onCancel={() => setManagement(false)}
      >
        <div className="project-list">
          {!projects.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          {projects.map((project) => (
            <div className="managed-project" key={project.id}>
              <Space wrap>
                <strong>{projectName(project.root)}</strong>
                {!project.available && <Tag color="orange">{msg('Offline', '离线')}</Tag>}
                {!!project.hidden && <Tag>{msg('Removed', '已移除')}</Tag>}
              </Space>
              <Typography.Text type="secondary" className="desktop-path">
                {project.root}
              </Typography.Text>
              <Space wrap>
                {!project.available && (
                  <Button size="small" onClick={() => void choose(project.id)}>
                    {msg('Locate folder', '重新定位目录')}
                  </Button>
                )}
                {!project.hidden && (
                  <Button size="small" onClick={() => setRemoval({ project, erase: false })}>
                    {msg('Remove from list', '从列表移除')}
                  </Button>
                )}
                <Button size="small" danger onClick={() => setRemoval({ project, erase: true })}>
                  {msg('Delete app data', '删除应用数据')}
                </Button>
              </Space>
            </div>
          ))}
        </div>
        <Button type="primary" className="desktop-modal-button" onClick={() => void choose()}>
          {msg('Add project', '添加项目')}
        </Button>
      </Modal>
      <Modal
        open={!!removal}
        title={removal?.erase ? msg('Delete app data', '删除应用数据') : msg('Remove from list', '从列表移除')}
        okText={removal?.erase ? msg('Delete app data', '删除应用数据') : msg('Remove from list', '从列表移除')}
        okButtonProps={{ danger: !!removal?.erase }}
        cancelText={msg('Cancel', '取消')}
        onCancel={() => setRemoval(undefined)}
        onOk={() => {
          if (!removal) return;
          void update(bridge.remove(removal.project.id, removal.erase));
          setRemoval(undefined);
        }}
      >
        <Typography.Paragraph className="desktop-path">{removal?.project.root}</Typography.Paragraph>
        <Typography.Text>
          {removal?.erase
            ? msg(
                'Deletes scans, profiles, runs, cases, suites and notes from IfaceForge storage. Your source files are kept.',
                '将删除应用中保存的扫描、配置、运行记录、用例、套件和笔记。源文件予以保留。',
              )
            : msg('Add the same folder to reopen its app data.', '再次添加同一目录即可恢复其应用数据。')}
        </Typography.Text>
      </Modal>
      <Modal
        open={settings}
        title={msg('Preferences', '偏好设置')}
        footer={null}
        onCancel={() => setSettings(false)}
      >
        <div className="desktop-actions">
          <label htmlFor="desktop-language">{t('language')}</label>
          <Select
            id="desktop-language"
            virtual={false}
            value={lang}
            onChange={(locale) => void update(bridge.locale(locale))}
            options={[
              { label: 'English', value: 'en' },
              { label: '简体中文', value: 'zh-CN' },
            ]}
          />
          <Button onClick={() => void unwrap(bridge.releases()).catch(setError)}>
            {msg('Check for updates', '检查更新')}
          </Button>
        </div>
      </Modal>
      <Modal open={taskCenter} title={msg('Tasks', '任务')} footer={null} onCancel={() => setTaskCenter(false)}>
        <div className="project-list">
          {!tasks.scans.length && !tasks.versions?.length && !tasks.runs.length && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
          {tasks.versions?.map((task) => (
            <div className="managed-project" key={task.id}>
              <Space wrap>
                <strong>{taskProjectName(task.project)}</strong>
                <Tag>
                  {task.operation === 'compare'
                    ? msg('Version comparison', '版本比较')
                    : msg('Version scan', '版本扫描')}
                </Tag>
                <span>
                  {task.state === 'complete'
                    ? msg('Complete', '完成')
                    : task.state === 'failed'
                      ? msg('Failed', '失败')
                      : task.state === 'cancelled'
                        ? msg('Cancelled', '已取消')
                        : msg('Running', '运行中')}
                </span>
              </Space>
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    setTaskCenter(false);
                    void selectProject(task.project);
                  }}
                >
                  {msg('Open project', '打开项目')}
                </Button>
                {task.state === 'running' && (
                  <Button
                    size="small"
                    onClick={() => void scopedCommand(task.project)('git cancel', { id: task.id }).catch(setError)}
                  >
                    {t('cancel')}
                  </Button>
                )}
              </Space>
            </div>
          ))}
          {tasks.scans.map((scan) => (
            <div className="managed-project" key={scan.id}>
              <Space wrap>
                <strong>{taskProjectName(scan.project)}</strong>
                <Tag>
                  {scan.state === 'complete'
                    ? msg('Complete', '完成')
                    : running(scan)
                      ? t('scanning')
                      : scan.state === 'failed'
                        ? msg('Failed', '失败')
                        : msg('Cancelled', '已取消')}
                </Tag>
              </Space>
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    setTaskCenter(false);
                    void selectProject(scan.project, true);
                  }}
                >
                  {msg('Scan status', '扫描状态')}
                </Button>
                {running(scan) && (
                  <Button size="small" onClick={() => void cancelScan(scan)}>
                    {msg('Cancel scan', '取消扫描')}
                  </Button>
                )}
              </Space>
            </div>
          ))}
          {tasks.runs.map((run) => (
            <div className="managed-project" key={run.id}>
              <Space wrap>
                <strong>{taskProjectName(run.project)}</strong>
                <Tag>{run.kind}</Tag>
              </Space>
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    setTaskCenter(false);
                    void selectProject(run.project);
                  }}
                >
                  {msg('Open project', '打开项目')}
                </Button>
                <Button
                  size="small"
                  onClick={() => void scopedCommand(run.project)('run cancel', { id: run.id }).catch(setError)}
                >
                  {t('cancel')}
                </Button>
              </Space>
            </div>
          ))}
        </div>
      </Modal>
    </ConfigProvider>
  );
}
