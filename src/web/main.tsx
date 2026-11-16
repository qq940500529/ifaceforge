import {
  Alert,
  App as AntApp,
  Button,
  ConfigProvider,
  Layout,
  Menu,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import enUS from 'antd/es/locale/en_US.js';
import type { Locale as AntLocale } from 'antd/es/locale/index.js';
import zhCN from 'antd/es/locale/zh_CN.js';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { command as browserCommand } from './client.js';
import { CatalogPage } from './catalog-page.js';
import { ApiPage, McpPage } from './debug-pages.js';
import { SettingsPage, TestPage, WikiPage } from './manage-pages.js';
import { Code, ErrorView, Loading, Workspace, useLoad, type Project } from './components.js';
import { translator, type Language } from './i18n.js';
import './styles.css';
import { DesktopApplication, type DesktopContext } from './desktop.js';

const pages = ['catalog', 'api', 'mcp', 'skill', 'tests', 'wiki', 'settings'] as const;
type Page = (typeof pages)[number];
const defaultLocale: Language = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

export function Application({ desktop }: { desktop?: DesktopContext }) {
  const command = desktop?.command ?? browserCommand;
  const { message } = AntApp.useApp();
  const [localLang, setLang] = useState(defaultLocale);
  const lang = desktop?.lang ?? localLang;
  const [page, setPage] = useState<Page>('catalog');
  const [revision, setRevision] = useState(0);
  const [browserScan, setScan] = useState<{ complete: boolean; diagnostics: unknown[] }>();
  const [browserScanning, setScanning] = useState(false);
  const scan = desktop?.scan?.result ?? browserScan;
  const scanning = desktop
    ? desktop.scan?.state === 'running' || desktop.scan?.state === 'cancelling'
    : browserScanning;
  const [error, setError] = useState<unknown>();
  const [source, setSource] = useState<{ path: string; line?: number }>();
  const initial = useRef(false);
  const scanningNow = useRef(false);
  const project = useLoad(() => command<Project>('project'), [revision]);
  const sourceContent = useLoad(
    () => (source ? command<{ text: string }>('source show', { path: source.path }) : Promise.resolve(undefined)),
    [source?.path],
  );
  const t = translator(lang);
  const refresh = () => setRevision((value) => value + 1);

  async function updateLocale(locale: Language) {
    if (desktop) return desktop.setLocale(locale);
    setError(undefined);
    setLang(locale);
    try {
      const { settings } = await command<{ settings: { schemaVersion: number } }>('config show');
      await command('config apply', { body: { ...settings, locale } });
      refresh();
    } catch (error) {
      setError(error);
    }
  }

  async function scanProject() {
    if (desktop) return desktop.startScan();
    if (scanningNow.current) return;
    scanningNow.current = true;
    setScanning(true);
    setError(undefined);
    try {
      setScan(await command('scan'));
      refresh();
    } catch (error) {
      setError(error);
    } finally {
      scanningNow.current = false;
      setScanning(false);
    }
  }

  useEffect(() => {
    if (desktop || !project.data) return;
    if (project.data.locale) setLang(project.data.locale);
    if (!initial.current) {
      initial.current = true;
      if (!project.data.snapshot) void scanProject();
    }
  }, [project.data]);

  useEffect(() => {
    if (desktop && !desktop.visible) return;
    document.documentElement.lang = lang;
    document.title = t('brand');
  }, [lang, desktop?.visible]);

  useEffect(() => {
    if (desktop?.scan?.state === 'complete') refresh();
  }, [desktop?.scan?.id, desktop?.scan?.state]);

  useEffect(() => {
    if (desktop && !desktop.visible) setSource(undefined);
  }, [desktop?.visible]);

  const context = {
    lang,
    t,
    command,
    projectId: desktop?.project,
    project: project.data ?? { root: '', data: '', branch: '' },
    revision,
    refresh,
    setLocale: updateLocale,
    notify: (text: string) => {
      void message.success({ key: 'workspace-feedback', content: text });
    },
    showSource: (path: string, line?: number) => setSource({ path, line }),
  };
  const links = pages.map((key) => ({ key, label: t(key) }));
  return (
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      locale={lang === 'zh-CN' ? (zhCN as unknown as AntLocale) : (enUS as unknown as AntLocale)}
      theme={{
        token: {
          colorPrimary: '#245fc4',
          borderRadius: 8,
          fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei UI", sans-serif',
          colorBgLayout: '#f3f6fb',
        },
      }}
    >
      <Workspace.Provider value={context}>
        <Layout className="shell">
          {desktop ? (
            <div className="project-bar">
              <div className="project-title">
                <strong>{desktop.name}</strong>
                {project.data?.branch && <Tag>{project.data.branch}</Tag>}
                <div className="project-path" title={project.data?.root}>
                  {project.data?.root}
                </div>
              </div>
              {desktop.scanControl(() => setPage('catalog'))}
            </div>
          ) : (
            <Layout.Header className="top">
              <div className="brand">
                <span className="mark" aria-hidden="true">
                  {'{ }'}
                </span>
                {t('brand')}
              </div>
              <div className="project">
                <span className="project-path" title={project.data?.root}>
                  {project.data?.root}
                </span>
                {project.data?.branch && <Tag>{project.data.branch}</Tag>}
                <span>
                  {scanning
                    ? t('scanning')
                    : project.data?.snapshot
                      ? t('snapshot', { id: project.data.snapshot.slice(0, 8) })
                      : t('notScanned')}
                </span>
              </div>
              <Space>
                <Button type="primary" loading={scanning} onClick={() => void scanProject()}>
                  {t('scan')}
                </Button>
                <Space.Compact role="group" aria-label={t('language')}>
                  {(
                    [
                      ['zh-CN', '简体中文'],
                      ['en', 'English'],
                    ] as const
                  ).map(([locale, label]) => (
                    <Button
                      key={locale}
                      type={lang === locale ? 'primary' : 'default'}
                      aria-pressed={lang === locale}
                      onClick={() => {
                        if (lang !== locale) void updateLocale(locale);
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </Space.Compact>
              </Space>
            </Layout.Header>
          )}
          <Layout hasSider>
            <Layout.Sider width={170} className="side">
              <Menu
                mode="inline"
                selectedKeys={[page]}
                items={links}
                onClick={(item) => setPage(item.key as Page)}
              />
            </Layout.Sider>
            <Layout.Content className="main">
              <Select
                className="mobile-nav"
                virtual={false}
                aria-label={t('select')}
                value={page}
                onChange={setPage}
                options={links.map((item) => ({ value: item.key, label: item.label }))}
              />
              <Typography.Title level={2} className="page-title">
                {t(page)}
              </Typography.Title>
              <div className="stack">
                <ErrorView error={project.error || error} />
                {project.error ? (
                  <div>
                    <Button onClick={refresh}>{t('retry')}</Button>
                  </div>
                ) : null}
                {scan && !scan.complete && (
                  <Alert
                    type="warning"
                    title={t('scanIncomplete')}
                    description={
                      <details>
                        <summary>{t('details')}</summary>
                        <Code value={scan.diagnostics} />
                      </details>
                    }
                  />
                )}
                {!project.data ? (
                  <Loading />
                ) : page === 'catalog' ? (
                  <CatalogPage key="catalog" />
                ) : page === 'skill' ? (
                  <CatalogPage key="skill" kind="skill" />
                ) : page === 'api' ? (
                  <ApiPage />
                ) : page === 'mcp' ? (
                  <McpPage />
                ) : page === 'tests' ? (
                  <TestPage />
                ) : page === 'wiki' ? (
                  <WikiPage />
                ) : (
                  <SettingsPage />
                )}
              </div>
            </Layout.Content>
          </Layout>
        </Layout>
        <Modal
          open={!!source}
          title={source?.path + (source?.line ? ':' + source.line : '')}
          width={850}
          onCancel={() => setSource(undefined)}
          footer={null}
        >
          <ErrorView error={sourceContent.error} />
          {sourceContent.loading ? <Loading /> : <Code value={sourceContent.data?.text} />}
        </Modal>
      </Workspace.Provider>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <AntApp message={{ maxCount: 1, top: 84 }}>
    {window.ifaceforge ? <DesktopApplication WorkspaceView={Application} /> : <Application />}
  </AntApp>,
);
