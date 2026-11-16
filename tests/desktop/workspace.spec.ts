import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

    for (let i = 0; i < 220; i++) {
      const path = join(firstDir, 'route-' + i + '.ts');
      writeFileSync(path, '// test fixture\n'.repeat(600) + "app.get('/test-" + i + "', handler);\n");
    }
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

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 680));
    for (const tab of ['Catalog', 'HTTP API', 'MCP', 'Skills', 'Tests', 'Wiki', 'Local settings']) {
      const navigation = page.locator('.mobile-nav:visible');
      await navigation.click();
      await page.getByRole('option', { name: tab, exact: true }).click();
      await expect(page.getByRole('option', { name: tab, exact: true })).not.toBeVisible();
      await expect(page.getByRole('heading', { name: tab, exact: true }).first()).toBeVisible();
      await page.screenshot({
        path: info.outputPath('narrow-' + tab.replaceAll(' ', '-') + '.png'),
        style: '.project-path { visibility: hidden !important }',
        scale: 'css',
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
    await button('New request').click();
    await page.getByRole('textbox', { name: 'Target URL or profile path' }).fill(target + '?test=1');
    await button('Preview target').click();
    await expect(page.getByText('GET ' + target + '?test=1', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Target URL or profile path' }).fill(target);
    await expect(page.getByText('GET ' + target + '?test=1', { exact: true })).not.toBeVisible();
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
    await expect(page.getByText('"value": "desktop tool result"', { exact: false })).toBeVisible();
    await snapshot('mcp-tool');
    await button('Disconnect').click();
    await expect(button('Connect')).toBeVisible();

    await navigate('Wiki');
    await choose(app, exportPath);
    await button('Choose folder').click();
    await button('Preview Wiki').click();
    await expect(page.getByRole('heading', { name: 'IfaceForge Wiki' })).toBeVisible();
    const changes = page.locator('summary').filter({ hasText: /Changed pages/ });
    await changes.click();
    await expect(changes.locator('..')).toHaveAttribute('open', '');
    await snapshot('wiki-changes');
    await changes.click();
    await button('Generate Wiki').click();
    await expect(button('Open export directory')).toBeVisible();
    expect(existsSync(join(exportPath, 'catalog.json'))).toBe(true);

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
  } finally {
    await app.close();
    await close(mcp);
    await close(service);
    sample.destroy();
  }
});
