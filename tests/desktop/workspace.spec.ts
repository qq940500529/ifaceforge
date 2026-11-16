import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { git } from '../../src/app/project.js';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { address, close, fixture, ifg, repositoryRoot } from '../support/fixture.js';
// @ts-expect-error This executable JavaScript fixture has no TypeScript declaration.
import { taskApp } from '../../fixtures/express/app.mjs';
// @ts-expect-error This executable JavaScript fixture has no TypeScript declaration.
import { mcpHttp } from '../../fixtures/express/mcp.mjs';

const require = createRequire(import.meta.url);
const installed = process.env.IFG_DESKTOP_EXE;

async function choose(app: ElectronApplication, path?: string) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: !selected, filePaths: selected ? [selected] : [] });
  }, path);
}
async function boot(data: string) {
  return await _electron.launch({
    executablePath: installed ?? (require('electron') as string),
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ...(installed ? [] : [repositoryRoot]),
      '--lang=en-US',
    ],
    cwd: repositoryRoot,
    env: { ...process.env, IFG_DATA_HOME: data },
  });
}

test('launches the desktop, switches projects and scans with a page popup', async ({}, info) => {
  const first = fixture('express');
  const second = fixture('fastapi');
  const another = join(second.root, 'nested');
  mkdirSync(another);
  const app = await boot(first.data);
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    expect(page.url()).toBe('ifaceforge://workbench/index.html');
    const title = page.locator('.project-title strong');
    const header = page.locator('.desktop-header');
    const switcher = header.getByRole('combobox');
    await expect(header.getByRole('button', { name: 'Add project' })).toBeVisible();
    await choose(app);
    await header.getByRole('button', { name: 'Add project' }).click();
    await expect(page.getByText('Add a Git project to get started')).toBeVisible();
    await choose(app, another);
    await header.getByRole('button', { name: 'Add project' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm Git worktree' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await header.getByRole('button', { name: 'Add project' }).click();
    await page.getByRole('button', { name: 'Use this worktree' }).click();
    await expect(title).toHaveText(basename(second.root));
    await page.getByRole('button', { name: 'Scan project', exact: true }).click();
    await expect(page.locator('.scan-panel:visible')).toBeVisible();
    await expect(page.locator('.scan-panel:visible')).toHaveAttribute('data-scan-state', 'complete');
    await page.screenshot({
      path: info.outputPath('desktop-scan.png'),
      style: '.project-path { visibility: hidden !important }',
      scale: 'css',
    });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('button', { name: /GET \/inventory/ }).first()).toBeVisible();
    await page.getByRole('menuitem', { name: 'HTTP API', exact: true }).click();
    await page.getByRole('button', { name: 'New request' }).click();
    const target = page.getByRole('textbox', { name: 'Target URL or profile path' });
    await target.fill('http://127.0.0.1:9411/retained-draft');

    const firstDir = join(first.root, 'same name tests');
    mkdirSync(firstDir);
    await choose(app, first.root);
    await header.getByRole('button', { name: 'Add project' }).click();
    await expect(page.locator('.project-path:visible')).toHaveText(first.root);

    // A large tracked source holds the real scanner open long enough on fast runners.
    writeFileSync(join(firstDir, 'routes.js'), "app.get('/cancellable', handler);\n".repeat(180_000));
    git(first.root, ['add', '.']);
    await page.getByRole('button', { name: 'Scan project', exact: true }).click();
    await expect(page.locator('.scan-panel:visible')).toBeVisible();
    const cancel = page.getByRole('button', { name: 'Cancel scan', exact: true });
    await cancel.click();
    await expect(page.locator('.scan-panel:visible')).toHaveAttribute('data-scan-state', 'cancelled');
    await page.getByRole('button', { name: 'Scan again' }).click();
    await page.getByRole('button', { name: 'Close scan status' }).click();
    await switcher.click();
    await page.getByRole('option', { name: basename(second.root), exact: true }).click();
    await header.getByRole('button', { name: /Tasks/ }).click();
    await expect(page.getByRole('dialog', { name: 'Tasks' })).toBeVisible();
    expect(
      await page.getByRole('dialog', { name: 'Tasks' }).getByRole('button', { name: 'Scan status' }).count(),
    ).toBe(2);
    await page.getByRole('dialog', { name: 'Tasks' }).getByRole('button', { name: 'Close' }).click();

    // Select the other worktree again through its native folder path and check its draft.
    await choose(app, second.root);
    await header.getByRole('button', { name: 'Add project' }).click();
    await expect(page.locator('.project-path:visible')).toHaveText(second.root);
    await expect(target).toHaveValue('http://127.0.0.1:9411/retained-draft');
    expect(await page.evaluate(() => ({ node: 'require' in window, width: innerWidth }))).toEqual({
      node: false,
      width: expect.any(Number),
    });
    const blocked = await page.evaluate(async () => window.ifaceforge!.command('invalid-id', 'stop', {}));
    expect(blocked.ok).toBe(false);

    const tabs = ['Catalog', 'HTTP API', 'MCP', 'Skills', 'Tests', 'Wiki', 'Local settings'];
    for (const width of [1440, 1200, 960, 820, 720, 640, 600]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 680), width);
      await expect
        .poll(() => page.evaluate(() => Math.abs(innerWidth - document.documentElement.clientWidth)))
        .toBeLessThan(30);
      for (const tab of tabs) {
        const navigation = page.locator('.mobile-nav:visible');
        if (await navigation.isVisible()) {
          await navigation.click();
          await page.getByRole('option', { name: tab, exact: true }).click();
          await expect(page.getByRole('option', { name: tab, exact: true })).not.toBeVisible();
        } else {
          await page.getByRole('menuitem', { name: tab, exact: true }).click();
        }
        await expect(page.getByRole('heading', { name: tab, exact: true }).first()).toBeVisible();
        const layout = await page.evaluate(() => ({
          viewport: innerWidth,
          content: document.documentElement.scrollWidth,
          buttons: [...document.querySelectorAll('.desktop-actions button')].every((el) => {
            const bounds = el.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth;
          }),
        }));
        expect(layout.content, width + ' px ' + tab).toBeLessThanOrEqual(layout.viewport);
        expect(layout.buttons, width + ' px ' + tab).toBe(true);
        if (width === 600 || tab === 'HTTP API') {
          await page.screenshot({
            path: info.outputPath(width + '-' + tab.replaceAll(' ', '-') + '.png'),
            style: '.project-path { visibility: hidden !important }',
            scale: 'css',
          });
        }
      }
    }
    await header.getByRole('button', { name: 'Preferences' }).click();
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByRole('combobox').click();
    await page.getByRole('option', { name: '简体中文' }).click();
    await expect(page.getByRole('dialog', { name: '偏好设置' })).toBeVisible();
    expect(errors).toEqual([]);
    expect(existsSync(join(first.root, '.devtools'))).toBe(false);
  } finally {
    await app.close();
    first.destroy();
    second.destroy();
  }
});

test('uses desktop controls for source, requests, MCP, tests, Wiki and project data', async ({}, info) => {
  const sample = fixture('express');
  const service = createServer(taskApp());
  const origin = await address(service);
  const mcp = mcpHttp();
  const transport = await address(mcp);
  const target = origin + '/tasks/42';
  const profile = await ifg(
    sample.root,
    'profile',
    'put',
    '--file',
    sample.write('demo.json', {
      schemaVersion: 1,
      id: 'demo',
      name: 'Test environment',
      mcp: { transport: 'streamableHttp', url: transport + '/mcp' },
    }),
  );
  expect(profile.exit).toBe(0);
  const stdio = await ifg(
    sample.root,
    'profile',
    'put',
    '--file',
    sample.write('stdio-profile.json', {
      schemaVersion: 1,
      id: 'stdio-demo',
      name: 'Stdio environment',
      mcp: {
        transport: 'stdio',
        command: process.execPath,
        args: [join(repositoryRoot, 'fixtures', 'express', 'mcp.mjs'), 'stdio', 'modern'],
      },
    }),
  );
  expect(stdio.exit).toBe(0);
  const app = await boot(sample.data);
  try {
    const page = await app.firstWindow();
    const header = page.locator('.desktop-header');
    const navigate = (name: string) => page.getByRole('menuitem', { name, exact: true }).click();
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const snapshot = (name: string) =>
      page.screenshot({
        path: info.outputPath(name + '.png'),
        animations: 'disabled',
        scale: 'css',
        style: '.project-path, .desktop-path { visibility: hidden !important }',
      });
    const exportPath = join(sample.data, 'selected export');
    mkdirSync(exportPath);
    const backupPath = join(sample.data, 'project-backup.json');
    await choose(app, sample.root);
    await header.getByRole('button', { name: 'Add project' }).click();
    await button('Scan project').click();
    await expect(page.locator('.scan-panel:visible')).toHaveAttribute('data-scan-state', 'complete');
    await button('View catalog').click();
    await page
      .getByRole('button', { name: /GET \/tasks\/\{id\}/ })
      .first()
      .click();
    const definition = page.locator('summary').filter({ hasText: 'Definition' }).first();
    await definition.click();
    await expect(definition.locator('..')).toHaveAttribute('open', '');
    await snapshot('catalog-details');
    await definition.click();
    await button('View source').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    await navigate('Skills');
    await page
      .getByRole('button', { name: /read.tasks/i })
      .first()
      .click();
    await page.getByRole('tab', { name: 'Raw source' }).click();
    await page.getByRole('tab', { name: 'References' }).click();
    await button('View source').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Markdown' }).click();

    await navigate('HTTP API');
    await choose(app, join(sample.root, 'openapi.yml'));
    await button('Import OpenAPI').click();
    await button('Choose file').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await button('New request').click();
    await page.getByRole('textbox', { name: 'Target URL or profile path' }).fill(target);
    await button('Add parameter').click();
    await page.getByRole('textbox', { name: 'Query parameters Name 1' }).fill('test');
    await page.getByRole('textbox', { name: 'Query parameters value 1' }).fill('1');
    await button('Add header').click();
    await page.getByRole('textbox', { name: 'Headers Name 1' }).fill('x-ifg-test');
    await page.getByRole('textbox', { name: 'Headers value 1' }).fill('desktop');
    await button('Preview target').click();
    await expect(page.getByText('GET ' + target + '?test=1', { exact: true })).toBeVisible();
    await page
      .locator('summary')
      .filter({ hasText: /^Query pairs/ })
      .click();
    await expect(page.getByRole('textbox', { name: 'Query pairs (JSON)' })).toBeVisible();
    await page
      .locator('summary')
      .filter({ hasText: /^Query pairs/ })
      .click();
    await button('Remove Query parameters 1').click();
    await expect(page.getByText('GET ' + target + '?test=1', { exact: true })).not.toBeVisible();
    await button('Copy cURL').click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('x-ifg-test');
    await button('Send request').click();
    await expect(page.getByText('Sample task', { exact: false }).first()).toBeVisible();
    await button('Save as case').click();
    await page.getByRole('textbox', { name: 'Case ID' }).fill('desktop-ui');
    await page.getByRole('textbox', { name: 'Case name' }).fill('Desktop UI case');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await snapshot('http-response');

    await navigate('Tests');
    await button('Desktop UI case').click();
    await button('Run').click();
    await expect(page.getByText('Sample task', { exact: false }).first()).toBeVisible();
    await snapshot('test-report');

    await navigate('MCP');
    await page.getByRole('combobox', { name: 'Profile', exact: true }).click();
    await page.getByRole('option', { name: 'Test environment', exact: true }).click();
    await page.locator('summary').filter({ hasText: 'Details' }).first().click();
    await button('Connect').click();
    await button('Discover').click();
    await button('echo').click();
    await page.getByRole('textbox', { name: 'value *', exact: true }).fill('desktop tool result');
    await button('Call tool').click();
    await expect(
      page.locator('pre.code').filter({ hasText: '"value": "desktop tool result"' }).first(),
    ).toBeVisible();
    await snapshot('mcp-tool');
    await button('Disconnect').click();
    await expect(button('Connect')).toBeVisible();
    await page.getByRole('combobox', { name: 'Profile', exact: true }).click();
    await page.getByRole('option', { name: 'Stdio environment', exact: true }).click();
    await button('Connect').click();
    await button('Discover').click();
    await page.getByRole('tab', { name: 'Resources', exact: true }).click();
    await button('task').click();
    await button('Read resource').click();
    await expect(page.getByText('Sample task 42', { exact: false }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Prompts', exact: true }).click();
    await button('task-summary').click();
    await page.getByRole('textbox', { name: 'Arguments (JSON)', exact: true }).fill('{"title":"desktop audit"}');
    await button('Get prompt').click();
    await expect(page.getByText('Summarize desktop audit', { exact: false }).first()).toBeVisible();
    await button('Disconnect').click();

    await navigate('Wiki');
    await choose(app, exportPath);
    await button('Choose folder').click();
    const previewWiki = page.getByTestId('wiki-preview');
    await expect(previewWiki).toBeVisible();
    await previewWiki.click();
    await expect(page.getByRole('heading', { name: 'IfaceForge Wiki' })).toBeVisible();
    const changes = page.locator('summary').filter({ hasText: /Changed pages/ });
    await changes.click();
    await expect(changes.locator('..')).toHaveAttribute('open', '');
    await snapshot('wiki-changes');
    await changes.click();
    await button('read-tasks').click();
    const note = page.getByRole('textbox', { name: 'Notes', exact: true });
    await note.fill('Desktop QA note');
    await button('Save note').click();
    await expect(page.getByText('Desktop QA note', { exact: true })).toBeVisible();
    await page.getByTestId('wiki-build').click();
    await expect(page.getByTestId('wiki-open')).toBeVisible();
    expect(existsSync(join(exportPath, 'catalog.json'))).toBe(true);
    const jsonPath = join(sample.data, 'catalog-download.json');
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, jsonPath);
    await page.getByTestId('wiki-export').click();
    await expect.poll(() => existsSync(jsonPath)).toBe(true);
    expect(JSON.parse(readFileSync(jsonPath, 'utf8')).items.length).toBeGreaterThan(0);

    await navigate('Local settings');
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, backupPath);
    await button('Back up').click();
    await expect.poll(() => existsSync(backupPath)).toBe(true);
    await choose(app, backupPath);
    await button('Restore').click();
    await expect(page.getByRole('dialog', { name: /Replace this project/ })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await snapshot('local-settings');

    await header.getByRole('button', { name: 'Manage projects' }).click();
    const manager = page.getByRole('dialog', { name: 'Manage projects' });
    await manager.getByRole('button', { name: 'Remove from list' }).click();
    await page
      .getByRole('dialog', { name: 'Remove from list', exact: true })
      .getByRole('button', { name: 'Remove from list', exact: true })
      .click();
    await manager.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('Add a Git project to get started')).toBeVisible();
    await choose(app, sample.root);
    await header.getByRole('button', { name: 'Add project' }).click();
    await expect(page.locator('.project-path:visible')).toHaveText(sample.root);
    expect((await ifg(sample.root, 'case', 'list')).result.data.total).toBe(1);
    await header.getByRole('button', { name: 'Manage projects' }).click();
    await manager.getByRole('button', { name: 'Delete app data' }).click();
    await page
      .getByRole('dialog', { name: 'Delete app data', exact: true })
      .getByRole('button', { name: 'Delete app data' })
      .click();
    await manager.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('Add a Git project to get started')).toBeVisible();
    expect(existsSync(join(sample.root, 'openapi.yml'))).toBe(true);
    expect((await ifg(sample.root, 'project', 'list')).result.data).toEqual([]);
  } finally {
    await app.close();
    await close(mcp);
    await close(service);
    sample.destroy();
  }
});
