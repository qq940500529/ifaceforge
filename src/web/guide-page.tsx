import { Button, Card, Space, Typography } from 'antd';
import { useState } from 'react';
import type { guide, guideDiagnostics } from '../app/guides.js';
import { download } from './client.js';
import { Code, ErrorView, Markdown, useLoad, useWorkspace } from './components.js';

export function GuidePage({ snapshot }: { snapshot?: string }) {
  const { command, lang, project, showSource } = useWorkspace();
  const [issues, setIssues] = useState<ReturnType<typeof guideDiagnostics>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const text = (en: string, cn: string) => (lang === 'en' ? en : cn);
  const loaded = useLoad(() => command<ReturnType<typeof guide>>('guide show', { lang }), [command, lang]);
  const selected = snapshot ?? project.snapshot;
  async function check() {
    setBusy(true);
    setError(undefined);
    try {
      setIssues(await command<ReturnType<typeof guideDiagnostics>>('guide validate', { snapshot: selected }));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card size="small">
      <div className="stack">
        <ErrorView error={error || loaded.error} />
        {loaded.data && <Markdown>{loaded.data.markdown}</Markdown>}
        <Space wrap>
          <Button disabled={!loaded.data} onClick={() => download('ifaceforge-guide.json', loaded.data)}>
            {text('Export guide JSON', '导出指南 JSON')}
          </Button>
          <Button loading={busy} disabled={!selected} onClick={() => void check()}>
            {text('Check scan diagnostics', '检查扫描诊断')}
          </Button>
        </Space>
        {loaded.data && (
          <details>
            <summary>{text('Compatibility matrix', '兼容矩阵')}</summary>
            <Code value={loaded.data.compatibility} />
          </details>
        )}
        {issues?.snapshot === selected && issues && (
          <div className="stack">
            <Typography.Text role="status">
              {issues.issues.length
                ? text(issues.issues.length + ' scan diagnostics', issues.issues.length + ' 条扫描诊断')
                : text('No scan diagnostics', '无扫描诊断')}
            </Typography.Text>
            {issues.issues.map((issue, index) => (
              <details key={issue.code + ':' + index}>
                <summary>
                  {issue.severity} · {issue.rule} {issue.path}
                </summary>
                <p>{issue.message}</p>
                {'fix' in issue && <p>{issue.fix}</p>}
                {issue.path && (
                  <Button
                    onClick={() =>
                      showSource(
                        issue.path!,
                        issue.line ?? undefined,
                        snapshot ? (issues.commit ?? undefined) : undefined,
                      )
                    }
                  >
                    {text('View source', '查看源码')}
                  </Button>
                )}
              </details>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
