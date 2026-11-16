import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { address, browserWorkbench, close, fixture, ifg, repositoryRoot } from '../support/fixture.js';
// @ts-expect-error JavaScript fixture is also runnable directly from Node.
import { taskApp } from '../../fixtures/express/app.mjs';
// @ts-expect-error JavaScript fixture is also runnable directly from Node.
import { mcpHttp } from '../../fixtures/express/mcp.mjs';

for (const language of ['en', 'zh-CN'] as const) {
  test.describe(language, () => {
    test.use({ locale: language });
    test('scan, debug, save, share and generate Wiki in ' + language, async ({ page }) => {
      const { root, destroy } = fixture();
      const service = createServer(taskApp());
      const serviceUrl = await address(service);
      const zh = language === 'zh-CN';
      const host = await browserWorkbench(root);
      const { url } = host;
      const label = (en: string, cn: string) => (zh ? cn : en);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
        await page.goto(url);
        await expect(page.getByRole('heading', { name: label('Catalog', '目录') })).toBeVisible();
        await page.getByRole('button', { name: label('Scan project', '扫描项目') }).click();
        await expect(page.getByRole('button', { name: /GET \/tasks\/\{id\}/ }).first()).toBeVisible();
        await page.getByRole('menuitem', { name: 'HTTP API', exact: true }).click();
        await page.getByRole('button', { name: label('New request', '新建请求') }).click();
        await page
          .getByRole('textbox', { name: label('Target URL or profile path', '目标 URL 或环境相对路径') })
          .fill(serviceUrl + '/tasks/42');
        await page
          .getByRole('textbox', { name: label('Assertions (JSON)', '断言（JSON）') })
          .fill('[{"type":"status","equals":200}]');
        await page.getByRole('button', { name: label('Send request', '发送请求') }).click();
        await expect(page.getByText('Sample task', { exact: false }).first()).toBeVisible();
        await page.getByRole('button', { name: label('Save as case', '保存为用例') }).click();
        await page.getByRole('textbox', { name: label('Case ID', '用例 ID') }).fill('ui-case');
        await page.getByRole('textbox', { name: label('Case name', '用例名称') }).fill('Saved in browser');
        await page
          .getByRole('dialog')
          .getByRole('button', { name: label('Save', '保存'), exact: true })
          .click();
        await expect(page.getByRole('dialog')).not.toBeVisible();
        const exported = await ifg(root, 'case', 'export', 'ui-case');
        expect(exported.result.data.request.url).toBe(serviceUrl + '/tasks/42');
        const modified = { ...exported.result.data, name: 'Modified by CLI' };
        const file = join(root, 'case-from-cli.json');
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, JSON.stringify(modified));
        expect((await ifg(root, 'case', 'put', '--file', file, '--replace', '--version', '1')).exit).toBe(0);
        await page.getByRole('menuitem', { name: label('Tests', '测试'), exact: true }).click();
        await page.getByRole('button', { name: 'Modified by CLI' }).click();
        await page.getByRole('button', { name: label('Run', '运行'), exact: true }).click();
        await expect(page.getByText('Sample task', { exact: false }).first()).toBeVisible();
        await page.getByRole('menuitem', { name: 'Wiki', exact: true }).click();
        await page.getByRole('button', { name: label('Generate Wiki', '生成 Wiki') }).click();
        await expect(page.getByRole('heading', { name: label('IfaceForge Wiki', '接口工坊 Wiki') })).toBeVisible();
        const catalog = JSON.parse(readFileSync(join(host.data, 'wiki', 'catalog.json'), 'utf8'));
        expect(catalog.locale).toBe(language);
        await page.getByRole('button', { name: zh ? 'English' : '简体中文', exact: true }).click();
        await expect
          .poll(async () => (await ifg(root, 'config', 'show')).result.data.settings.locale)
          .toBe(zh ? 'en' : 'zh-CN');
        await page.reload();
        await expect(page.getByRole('heading', { name: zh ? 'Catalog' : '目录' })).toBeVisible();
        expect(errors).toEqual([]);
        if (!zh && process.env.IFG_SCREENSHOT) {
          await page.getByRole('button', { name: 'English', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();
          mkdirSync(join(repositoryRoot, 'docs', 'assets'), { recursive: true });
          await page.screenshot({
            path: join(repositoryRoot, 'docs', 'assets', 'catalog.png'),
            animations: 'disabled',
            mask: [page.locator('.project-path')],
            maskColor: '#14233b',
          });
        }
      } finally {
        await host.stop();
        await close(service);
        destroy();
      }
    });
  });
}

test('discovers an MCP tool and submits a schema field through the Web interface', async ({ page }) => {
  const { root, write, destroy } = fixture();
  const service = mcpHttp();
  const target = await address(service);
  const host = await browserWorkbench(root);
  try {
    const profile = await ifg(
      root,
      'profile',
      'put',
      '--file',
      write('mcp-profile.json', {
        schemaVersion: 1,
        id: 'demo',
        name: 'MCP demo',
        mcp: { transport: 'streamableHttp', url: target + '/mcp' },
      }),
    );
    expect(profile.exit).toBe(0);
    await page.goto(host.url);
    await page.getByRole('menuitem', { name: 'MCP', exact: true }).click();
    await page.getByRole('combobox', { name: 'Profile', exact: true }).click();
    await page.getByRole('option', { name: 'MCP demo', exact: true }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await page.getByRole('button', { name: 'echo', exact: true }).click();
    await page.getByRole('textbox', { name: 'value *', exact: true }).fill('from basic field');
    await page.getByRole('button', { name: 'Call tool', exact: true }).click();
    await expect(page.getByText('"value": "from basic field"', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  } finally {
    await host.stop();
    await close(service);
    destroy();
  }
});
