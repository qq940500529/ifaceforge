import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
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

async function closeDesktop(app: ElectronApplication) {
  const process = app.process();
  if (process.exitCode !== null || process.signalCode !== null) return;
  const stopped = once(process, 'exit');
  await app.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 35);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fallback = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        process.kill();
        reject(new Error('Electron did not exit after quit'));
      }, 10000);
    });
    const [code] = await Promise.race([stopped, fallback]);
    expect(code).toBe(0);
  } finally {
    clearTimeout(timer);
  }
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

    // Track several sources so cancellation can reach the scanner before it saves its result.
    for (let index = 0; index < 4; index++) {
      writeFileSync(
        join(firstDir, 'routes-' + index + '.js'),
        "import express from 'express'; const app = express();\n" +
          "app.get('/cancellable', handler);\n".repeat(60_000),
      );
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
        if (tab === 'Catalog') {
          const badges = page.locator('.catalog-labels:visible').first();
          await expect(badges.locator('.catalog-kind')).toBeVisible();
          const separated = await badges.evaluate((row) => {
            const container = row.getBoundingClientRect();
            const items = Array.from(row.children, (child) => child.getBoundingClientRect());
            return items.every((item, index) => {
              const next = items[index + 1];
              return item.right <= container.right && (!next || next.left > item.right || next.top > item.bottom);
            });
          });
          expect(separated, width + ' px catalog labels').toBe(true);
        }
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
    await closeDesktop(app);
    first.destroy();
    second.destroy();
  }
});

test('uses desktop controls for source, requests, MCP, tests, Wiki and project data', async ({}, info) => {
  test.setTimeout(150_000);
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
    const button = (name: string) =>
      page
        .getByRole('button', { name, exact: true })
        .or(
          page
            .locator('button:visible')
            .filter({ hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }),
        );
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
    await button('Connect').click();
    await expect(button('echo')).toBeVisible();
    const serviceDetails = page.locator('summary').filter({ hasText: /^Service details$/ });
    await serviceDetails.click();
    await expect(serviceDetails.locator('..')).toHaveAttribute('open', '');
    await serviceDetails.click();
    await page.getByRole('textbox', { name: 'Search MCP directory' }).fill('structured JSON');
    await button('echo').click();
    await expect(button('slow')).not.toBeVisible();
    await page.getByRole('textbox', { name: 'Search MCP directory' }).clear();
    await expect(button('slow')).toBeVisible();
    await page.getByRole('tab', { name: 'Details', exact: true }).click();
    const outputSchema = page.locator('summary').filter({ hasText: /^Output schema$/ });
    await outputSchema.click();
    await expect(outputSchema.locator('..')).toHaveAttribute('open', '');
    await snapshot('mcp-details');
    await outputSchema.click();
    await page.getByRole('tab', { name: 'Test', exact: true }).click();
    await page.getByRole('textbox', { name: 'value *', exact: true }).fill('desktop tool result');
    await button('Add assertion').click();
    const pointer = page.getByRole('combobox', { name: 'JSON Pointer', exact: true });
    await pointer.fill('/value');
    await page.getByRole('textbox', { name: 'Expected value', exact: true }).fill('"different"');
    await button('Call tool').click();
    await expect(
      page.locator('pre.code:visible').filter({ hasText: '"expected": "different"' }).first(),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Expected value', exact: true }).fill('"desktop tool result"');
    await button('Call tool').click();
    await expect(
      page.locator('pre.code:visible').filter({ hasText: '"value": "desktop tool result"' }).first(),
    ).toBeVisible();
    await expect(page.locator('.mcp-inspector').getByText('Passed', { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(page.locator('.mcp-inspector .list-button')).toHaveCount(2);
    await page.locator('.mcp-inspector .list-button').first().click();
    await expect(button('Export JSON')).toBeVisible();
    await page.getByRole('tab', { name: 'Test', exact: true }).click();
    await snapshot('mcp-tool');
    await page.locator('.mcp-layout:visible').screenshot({
      path: info.outputPath('mcp-showcase.png'),
      style: '.desktop-header { visibility: hidden !important }',
      scale: 'css',
      animations: 'disabled',
    });
    const saveMcpCase = async (id: string) => {
      await button('Save as case').click();
      await page.getByRole('textbox', { name: 'Case ID' }).fill(id);
      await page.getByRole('textbox', { name: 'Case name' }).fill(id);
      await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
    };
    await saveMcpCase('mcp-echo');
    await button('Disconnect').click();
    await expect(button('Connect')).toBeVisible();
    await page.getByRole('combobox', { name: 'Profile', exact: true }).click();
    await page.getByRole('option', { name: 'Stdio environment', exact: true }).click();
    await button('Connect').click();
    await button('Discover').click();
    await button('Resources').click();
    await button('task').click();
    await button('Read resource').click();
    await expect(page.getByText('Sample task 42', { exact: false }).first()).toBeVisible();
    await saveMcpCase('mcp-resource');
    await button('sample-image').click();
    await button('Read resource').click();
    await expect(page.getByRole('img', { name: 'MCP response image' })).toBeVisible();
    await button('Resource templates').click();
    await button('task-template').click();
    await expect(button('Read resource')).toBeDisabled();
    await page.getByRole('textbox', { name: 'id *', exact: true }).fill('43');
    await expect(page.getByRole('textbox', { name: 'Resource URI', exact: true })).toHaveValue('task://43');
    await button('Read resource').click();
    await expect(page.getByText('Synthetic task', { exact: true }).first()).toBeVisible();
    await saveMcpCase('mcp-template');
    await button('Prompts').click();
    await button('task-summary').click();
    await page.getByRole('textbox', { name: 'title *', exact: true }).fill('desktop audit');
    await button('Get prompt').click();
    await expect(page.getByText('Summarize desktop audit', { exact: false }).first()).toBeVisible();
    await saveMcpCase('mcp-prompt');
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
    await expect(page.locator('.markdown').getByText('Desktop QA note', { exact: true })).toBeVisible();
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
    await button('Create').click();
    await page.getByRole('textbox', { name: 'Profile ID', exact: true }).fill('local-audit');
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Local profile audit');
    await page.getByRole('textbox', { name: 'HTTP base URL', exact: true }).fill(origin);
    await page.getByRole('combobox', { name: 'MCP transport' }).click();
    await page.getByRole('option', { name: 'Streamable HTTP', exact: true }).click();
    await page.getByRole('textbox', { name: 'MCP URL', exact: true }).fill(transport + '/mcp');
    await button('Save').click();
    await expect(button('Local profile audit')).toBeVisible();
    expect(await page.locator('.ant-message-notice:visible').count()).toBeLessThanOrEqual(1);
    await button('Remove').click();
    await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
    await expect(button('Local profile audit')).not.toBeVisible();

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
    expect((await ifg(sample.root, 'case', 'list')).result.data.total).toBe(5);
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
    await closeDesktop(app);
    await close(mcp);
    await close(service);
    sample.destroy();
  }
});

test('keeps live MCP targets, drafts and results within their project', async ({}, info) => {
  const first = fixture('express');
  const second = fixture('fastapi');
  const server = mcpHttp();
  const url = (await address(server)) + '/mcp';
  const app = await boot(first.data);
  try {
    const page = await app.firstWindow();
    const header = page.locator('.desktop-header');
    const visible = page.locator('.mcp-workbench:visible');
    const argument = visible.getByRole('textbox', { name: 'value *', exact: true });
    async function addAndTest(root: string, value: string) {
      await choose(app, root);
      await header.getByRole('button', { name: 'Add project', exact: true }).click();
      await expect(page.locator('.project-path:visible')).toHaveText(root);
      const profile = await page.evaluate(async (endpoint) => {
        const state = await window.ifaceforge!.state();
        if (!state.ok || !state.data.selected) throw new Error('Project not selected');
        return window.ifaceforge!.command(state.data.selected, 'profile put', {
          body: {
            schemaVersion: 1,
            id: 'same',
            name: 'Shared service',
            mcp: { transport: 'streamableHttp', url: endpoint },
          },
        });
      }, url);
      expect(profile.ok).toBe(true);
      await page.getByRole('menuitem', { name: 'MCP', exact: true }).click();
      await visible.getByRole('combobox', { name: 'Profile', exact: true }).click();
      await page.getByRole('option', { name: 'Shared service', exact: true }).click();
      await visible.getByRole('button', { name: 'Connect', exact: true }).click();
      await visible.getByRole('button', { name: 'echo', exact: true }).click();
      await argument.fill(value);
      await visible.getByRole('button', { name: 'Call tool', exact: true }).click();
      await expect(visible.locator('pre.code:visible').filter({ hasText: value }).first()).toBeVisible();
    }
    await addAndTest(first.root, 'first project input');
    const session = (await ifg(first.root, 'mcp', 'status')).result.data[0];
    expect(session.profile).toBe('same');
    const fromCli = await ifg(
      first.root,
      'mcp',
      'call',
      'echo',
      '--connection',
      session.id,
      '--args',
      '{"value":"from CLI"}',
    );
    expect(fromCli.exit).toBe(0);
    expect(JSON.stringify(fromCli.result.data)).toContain('from CLI');
    await addAndTest(second.root, 'second project input');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 680));
    const filters = visible.getByRole('group', { name: 'MCP capability types' });
    for (const name of ['Tools', 'Resources', 'Resource templates', 'Prompts']) {
      const control = filters.getByRole('button', { name, exact: true });
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      expect(await control.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    }
    await filters.getByRole('button', { name: 'Tools', exact: true }).click();
    await filters.screenshot({ path: info.outputPath('mcp-narrow-categories.png'), scale: 'css' });
    await header.getByRole('combobox', { name: 'Switch project', exact: true }).click();
    await page.getByRole('option', { name: basename(first.root), exact: true }).click();
    await expect(page.locator('.project-path:visible')).toHaveText(first.root);
    await expect(argument).toHaveValue('first project input');
    await expect(
      visible.locator('pre.code:visible').filter({ hasText: 'first project input' }).first(),
    ).toBeVisible();
    await expect(visible.locator('pre.code:visible').filter({ hasText: 'second project input' })).toHaveCount(0);
  } finally {
    await closeDesktop(app);
    await close(server);
    first.destroy();
    second.destroy();
  }
});

test('browses and compares selected versions with responsive graph controls', async ({}, info) => {
  test.setTimeout(120_000);
  const sample = fixture('express');
  const commit = (title: string, body: string) =>
    git(sample.root, [
      '-c',
      'user.name=IfaceForge Tests',
      '-c',
      'user.email=tests@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      title,
      '-m',
      body,
    ]);
  const config = JSON.parse(readFileSync(join(sample.root, '.ifaceforge.json'), 'utf8'));
  config.sources[0].adapters.push('fastapi');
  sample.write('.ifaceforge.json', config);
  writeFileSync(
    join(sample.root, 'custom-handler.py'),
    'from urllib.parse import urlsplit\ndef dispatch(handler):\n    route = urlsplit(handler.path)\n    if handler.command != "GET":\n        raise ValueError(route)\n',
  );
  git(sample.root, ['add', '.ifaceforge.json', 'custom-handler.py']);
  commit('Initial API definitions', 'Original contract and helper modules.');
  const common = git(sample.root, ['rev-parse', 'HEAD']).trim();
  for (let index = 0; index < 52; index++) git(sample.root, ['branch', 'team/topic-' + index]);
  git(sample.root, ['switch', '-qc', 'baseline']);
  commit('Keep the stable interface line', 'The baseline retains the original capabilities.');
  git(sample.root, ['switch', '-qc', 'feature-interfaces', common]);
  for (let index = 1; index <= 24; index++)
    commit('Maintenance ' + index, 'Repository history for visual review.');
  sample.write('openapi.versioned.json', {
    openapi: '3.2.0',
    info: { title: 'Version checks', version: '2' },
    paths: {
      '/version-check': {
        get: { summary: 'Check the selected Git version', responses: { 200: { description: 'Ready' } } },
      },
    },
  });
  sample.write('mcp-capabilities.json', {
    schemaVersion: 1,
    service: 'version-check',
    tools: [{ name: 'inspect-version' }],
  });
  writeFileSync(
    join(sample.root, 'skills', 'read-tasks', 'SKILL.md'),
    '---\nname: read-tasks\ndescription: Read tasks by Git version\n---\n\nReview the version-specific task.\n',
  );
  git(sample.root, ['add', '.']);
  commit(
    'Add versioned interfaces',
    'The contract, tool and skill are available on this branch.\n\nThe full message explains the new definitions.',
  );
  const feature = git(sample.root, ['rev-parse', 'HEAD']).trim();
  git(sample.root, ['tag', 'interfaces-v2']);
  const before = git(sample.root, ['status', '--porcelain=v1']);

  const app = await boot(sample.data);
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const field = (name: string) => page.getByRole('combobox', { name, exact: true });
    const option = async (name: string, label: RegExp) => {
      const control = field(name);
      await control.click();
      await control.fill(label.source.replace(/^\^/, ''));
      const listId = await control.getAttribute('aria-controls');
      const dropdown = page
        .locator('.ant-select-dropdown:visible')
        .filter({ has: page.locator('[id="' + listId + '"]') });
      await expect(dropdown.locator('.ant-select-item-option').filter({ hasText: label })).toBeVisible();
      await control.press('Enter');
    };
    const evidence = (name: string) =>
      page.screenshot({
        path: info.outputPath(name + '.png'),
        style: '.project-path { visibility: hidden !important }',
        scale: 'css',
      });
    await choose(app, sample.root);
    await page.locator('.desktop-header').getByRole('button', { name: 'Add project', exact: true }).click();
    await button('Refresh refs').click();
    await button('Versions and comparison').click();
    await expect(page.getByRole('heading', { name: 'Versions', exact: true })).toBeVisible();
    const first = page.locator('[data-commit="' + feature + '"]');
    await expect(first).toBeVisible();
    await expect(page.locator('.git-row')).toHaveCount(24);
    await expect(first.getByText('interfaces-v2')).toBeVisible();
    await first.locator('time').hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    await page.getByText('Git network', { exact: true }).hover();
    await first.hover({ position: { x: 25, y: 24 } });
    await expect(tooltip).toBeVisible();
    const mouseAt = await first.boundingBox();
    const tipAt = await tooltip.boundingBox();
    await page.mouse.move(mouseAt!.x + 67, mouseAt!.y + 29);
    await expect.poll(async () => (await tooltip.boundingBox())?.x).not.toBe(tipAt?.x);
    expect(
      await tooltip.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
      }),
    ).toBe(true);
    await evidence('versions-row-tooltip');
    await first.click();
    await expect(page.getByText('Commit time', { exact: true })).toBeVisible();
    await page.getByText('Show full message', { exact: true }).click();
    await expect(
      page.getByText('The full message explains the new definitions.', { exact: false }).last(),
    ).toBeVisible();
    await page.getByText('Show full message', { exact: true }).click();

    await page.getByText(/^All refs/).click();
    await button('Show more refs').click();
    await page.getByRole('textbox', { name: 'Find a branch' }).fill('topic-51');
    await button('team/topic-51').click();
    await expect(page.locator('.git-details').getByText('Initial API definitions')).toBeVisible();
    await page.getByText(/^All refs/).click();
    await option('Branches in graph', /^baseline/);
    await page.keyboard.press('Escape');
    await button('Show more').click();
    await expect(page.locator('.git-row')).toHaveCount(27);
    const find = page.getByRole('searchbox', { name: 'Find commit' });
    await find.fill('Maintenance 1');
    await find.press('Enter');
    await expect(page.locator('.git-details').getByText(/Maintenance 1/)).toBeVisible();

    await option('Base', /^baseline/);
    await option('Target', /^feature-interfaces/);
    await button('Swap').click();
    await button('Swap').click();
    await button('Compare').click();
    await expect(button('HTTP API 1')).toBeVisible();
    await expect(button('MCP 1')).toBeVisible();
    await expect(button('Skills 1')).toBeVisible();
    await button('HTTP API 1').click();
    await field('Comparison basis').click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: 'Common ancestor' })
      .click();
    await button('Apply basis').click();
    await expect(button('HTTP API 1')).toBeVisible();
    await page.getByText('GET /version-check', { exact: true }).click();
    await expect(button('Target source')).toBeVisible();
    await button('Target source').click();
    const modal = page.getByRole('dialog', { name: 'openapi.versioned.json' });
    await expect(modal.getByText(/Check the selected Git version/)).toBeVisible();
    await modal.getByRole('button', { name: 'Close' }).click();
    await button('Unified view').click();
    await expect(button('Side by side')).toBeVisible();
    await button('Side by side').click();
    await page.getByRole('textbox', { name: 'Filter changes' }).fill('missing');
    await expect(page.getByText('No changes', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Filter changes' }).clear();
    await button('MCP 1').click();
    await expect(page.getByText('inspect-version', { exact: true })).toBeVisible();
    await button('Skills 1').click();
    await expect(page.getByText('read-tasks', { exact: true })).toBeVisible();
    await button('Files 3').click();
    await option('Changed file', /openapi.versioned.json/);
    await expect(page.locator('.git-layout pre.code').filter({ hasText: 'version-check' })).toBeVisible();
    await page.getByRole('button', { name: /^Diagnostics \d+$/ }).click();
    await button('All capabilities 3').click();
    await page.locator('.page-title').scrollIntoViewIfNeeded();
    await app.evaluate(
      ({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      },
      join(sample.data, 'comparison.json'),
    );
    await button('Export JSON').click();
    await expect.poll(() => existsSync(join(sample.data, 'comparison.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(sample.data, 'comparison.json'), 'utf8')).target.sha).toBe(feature);
    await evidence('versions-desktop');

    await option('Browse version', /^feature-interfaces/);
    await expect(page.locator('.version-browse').getByText(feature.slice(0, 8), { exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Catalog', exact: true }).click();
    await expect(page.getByRole('button', { name: /GET \/version-check/ })).toBeVisible();
    await expect(page.getByText('API source coverage', { exact: true })).toBeVisible();
    await page
      .locator('summary')
      .filter({ hasText: /^\d+ route diagnostics$/ })
      .click();
    await page.getByRole('button', { name: /^custom-handler\.py:/ }).click();
    const coverageSource = page.getByRole('dialog', { name: /^custom-handler\.py:/ });
    await expect(coverageSource.getByText(/handler\.command/)).toBeVisible();
    await coverageSource.getByRole('button', { name: 'Close' }).click();
    await expect(button('Compare')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Developer guide', exact: true }).click();
    await page
      .locator('summary')
      .filter({ hasText: /^Compatibility matrix$/ })
      .click();
    await expect(page.locator('pre.code').filter({ hasText: 'Swagger 1.0' })).toBeVisible();
    await button('Check scan diagnostics').click();
    await expect(page.getByText(/^(?:No|\d+) scan diagnostics$/)).toBeVisible();
    await button('Export guide JSON').click();
    const fromCli = await ifg(sample.root, 'scan', 'start');
    expect(fromCli.exit).toBe(0);
    expect((await ifg(sample.root, 'task', 'watch', fromCli.result.data.id)).result.data.state).toBe('complete');
    await page
      .locator('.desktop-header')
      .getByRole('button', { name: /^Tasks/ })
      .click();
    const taskCenter = page.getByRole('dialog', { name: 'Tasks' });
    await expect(taskCenter.getByRole('button', { name: 'Scan status' })).toBeVisible();
    await taskCenter.getByRole('button', { name: 'Close' }).click();
    await button('Versions and comparison').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 750));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(640);
    await first.scrollIntoViewIfNeeded();
    await first.hover({ position: { x: 25, y: 23 } });
    await expect(tooltip).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await evidence('versions-narrow');
    expect(git(sample.root, ['status', '--porcelain=v1'])).toBe(before);
    expect(errors).toEqual([]);
  } catch (error) {
    process.stderr.write(String(error) + '\n');
    throw error;
  } finally {
    await closeDesktop(app);
    sample.destroy();
  }
});
