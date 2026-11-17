import { Alert, App, Button, Empty, Modal, Pagination, Segmented, Space, Spin, Tag } from 'antd';
import { useState } from 'react';
import { copyText, unwrap } from './client.js';
import { useLoad } from './components.js';
import type { ScanTask } from '../desktop/protocol.js';
import type { Language } from './i18n.js';
import type { Diagnostic } from '../scanner/model.js';
import {
  diagnosticDetails,
  diagnosticLocation,
  diagnosticText,
  scanDiagnostics,
} from '../app/scan-diagnostics.js';

type Filter = 'all' | 'error' | 'warning';
const pageSize = 15;

export function ScanDiagnostics({
  task,
  name,
  lang,
  close,
}: {
  task: ScanTask;
  name: string;
  lang: Language;
  close: () => void;
}) {
  const zh = lang === 'zh-CN';
  const { message } = App.useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const messages = useLoad(
    () => unwrap(window.ifaceforge!.scanDetails(task.project, task.id)),
    [task.project, task.id, task.state, task.warnings, task.errors],
  );
  const record = messages.data ?? task;
  const issues = scanDiagnostics(record).filter((issue) => issue.severity !== 'info');
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const shown = filter === 'all' ? issues : issues.filter((issue) => (issue.severity ?? 'warning') === filter);
  const current = Math.min(page, Math.max(1, Math.ceil(shown.length / pageSize)));

  async function copy(items: Diagnostic[]) {
    try {
      await copyText(items.map(diagnosticText).join('\n\n'));
      void message.success(zh ? '已复制到剪贴板' : 'Copied to clipboard');
    } catch {
      void message.error(zh ? '复制失败，请尝试逐条复制' : 'Could not copy. Try copying one entry at a time.');
    }
  }

  return (
    <Modal open width={680} title={zh ? '扫描诊断' : 'Scan diagnostics'} footer={null} onCancel={close}>
      <div className="scan-diagnostics">
        <div className="scan-diagnostics-toolbar">
          <span className="scan-diagnostics-project">{name}</span>
          <Button disabled={!issues.length} onClick={() => void copy(issues)}>
            {zh ? '复制全部诊断' : 'Copy all diagnostics'}
          </Button>
        </div>
        <Segmented<Filter>
          aria-label={zh ? '筛选诊断级别' : 'Filter diagnostics by severity'}
          value={filter}
          options={[
            { value: 'all', label: `${zh ? '全部' : 'All'} (${issues.length})` },
            { value: 'error', label: `${zh ? '错误' : 'Errors'} (${errors})` },
            { value: 'warning', label: `${zh ? '警告' : 'Warnings'} (${issues.length - errors})` },
          ]}
          onChange={(value) => {
            setFilter(value);
            setPage(1);
          }}
        />
        {!!messages.error && (
          <Alert type="error" showIcon title={zh ? '无法读取扫描诊断' : 'Unable to read scan diagnostics'} />
        )}
        {!shown.length &&
          (messages.loading ? (
            <Spin />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={zh ? '没有此级别的诊断' : 'No diagnostics at this severity'}
            />
          ))}
        <ul className="scan-diagnostics-list" aria-label={zh ? '扫描问题' : 'Scan issues'}>
          {shown.slice((current - 1) * pageSize, current * pageSize).map((issue, index) => (
            <li key={`${current}-${index}-${issue.code}`} className="scan-diagnostic">
              <div className="scan-diagnostics-toolbar">
                <Space size={8} wrap>
                  <Tag color={issue.severity === 'error' ? 'red' : 'gold'}>
                    {issue.severity === 'error' ? (zh ? '错误' : 'Error') : zh ? '警告' : 'Warning'}
                  </Tag>
                  <code>{issue.code}</code>
                </Space>
                <Button size="small" onClick={() => void copy([issue])}>
                  {zh ? '复制此条' : 'Copy entry'}
                </Button>
              </div>
              {diagnosticLocation(issue) && (
                <code className="scan-diagnostic-location">{diagnosticLocation(issue)}</code>
              )}
              <p>{issue.message}</p>
              {diagnosticDetails(issue) && <pre className="code">{diagnosticDetails(issue)}</pre>}
            </li>
          ))}
        </ul>
        {shown.length > pageSize && (
          <Pagination
            size="small"
            current={current}
            pageSize={pageSize}
            total={shown.length}
            onChange={setPage}
            showSizeChanger={false}
          />
        )}
      </div>
    </Modal>
  );
}
