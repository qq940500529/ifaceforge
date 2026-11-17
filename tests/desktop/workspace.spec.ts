import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { git } from '../../src/app/project.js';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { address, close, commitFixture, fixture, ifg, repositoryRoot } from '../support/fixture.js';
// @ts-expect-error This executable JavaScript fixture has no TypeScript declaration.
import { taskApp } from '../../fixtures/express/app.mjs';

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
      }, 30000);
    });
    const [code] = await Promise.race([stopped, fallback]);
    expect(code).toBe(0);
  } finally {
    clearTimeout(timer);
  }
}

test('shows and copies scan diagnostics and keeps long-list details in view', async ({}, info) => {
  test.setTimeout(120_000);
  const sample = fixture('express');
  sample.write('openapi.long.json', {
    openapi: '3.1.0',
    info: { title: 'Paged API', version: '1' },
    paths: Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `/long/item-${String(index).padStart(3, '0')}`,
        { get: { responses: { 200: { description: 'Ready' } } } },
      ]),
    ),
  });
  writeFileSync(
    join(sample.root, 'dynamic.mjs'),
    'import express from "express";\nconst router = express();\nrouter.get(process.env.MODE, handler);\n',
  );
  mkdirSync(join(sample.root, 'skills', 'bad-metadata'));
  writeFileSync(join(sample.root, 'skills', 'bad-metadata', 'SKILL.md'), '---\nname: BAD\n---\n# Invalid skill\n');
  writeFileSync(
    join(sample.root, 'skills', 'read-tasks', 'SKILL.md'),
    [
      '---',
      'name: read-tasks',
      'description: Read tasks from the local API',
      '---',
      '# Task formats',
      '',
      '| Task | State |',
      '| --- | --- |',
      '| Inspect | Ready |',
      '',
      '- [x] Prepared',
      '- [ ] Pending',
      '',
      'Keep ~~obsolete~~ fields out.[^schema]',
      '',
      '[^schema]: This is the reference note.',
      '',
      '<script>invalid preview code</script>',
    ].join('\n'),
  );
  git(sample.root, ['add', '.']);
  const app = await boot(sample.data);
  let assertionsPassed = false;
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    const header = page.getByRole('banner');
    const navigate = (name: string) => page.getByRole('menuitem', { name, exact: true }).click();
    await choose(app, sample.root);
    await header.getByRole('button', { name: 'Add project' }).click();
    await page.getByRole('button', { name: 'Scan project' }).click();
    const popup = page.locator('.scan-panel');
    await expect(popup.getByText('Scan completed with issues')).toBeVisible();
    await expect(popup.getByText('1 warning', { exact: true })).toBeVisible();
    await expect(popup.getByText('1 error', { exact: true })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'View diagnostics' })).toHaveClass(/ant-btn-primary/);
    await expect(popup.getByRole('button', { name: 'View catalog' })).not.toHaveClass(/ant-btn-primary/);
    await popup.screenshot({ path: info.outputPath('scan-actions-wide.png') });
    await popup.getByRole('button', { name: 'View diagnostics' }).click();
    const diagnostics = page.getByRole('dialog', { name: 'Scan diagnostics' });
    await expect(diagnostics.getByText('SKILL_METADATA')).toBeVisible();
    await expect(diagnostics.getByText('dynamic.mjs:3')).toBeVisible();
    await diagnostics.getByText('Warnings (1)', { exact: true }).click();
    await expect(diagnostics.getByText('SKILL_METADATA')).toHaveCount(0);
    await diagnostics.getByRole('button', { name: 'Copy entry' }).click();
    const copied = () => app.evaluate(({ clipboard }) => clipboard.readText());
    await expect.poll(copied).toContain('[WARNING] DYNAMIC_ROUTE\ndynamic.mjs:3');
    await diagnostics.getByRole('button', { name: 'Copy all diagnostics' }).click();
    await expect.poll(copied).toContain('[ERROR] SKILL_METADATA');
    await diagnostics.screenshot({ path: info.outputPath('scan-diagnostics.png') });
    await diagnostics.getByRole('button', { name: 'Close' }).click();

    for (const section of ['Catalog', 'HTTP API']) {
      await navigate(section);
      const list = page.getByRole('region', { name: 'Search the catalog', exact: true });
      await expect.poll(() => list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
      await list.evaluate((node) => (node.scrollTop = node.scrollHeight));
      const row = list.getByRole('button', { name: /GET \/long\/item-012/ });
      await row.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => scrollY);
      await row.click();
      const detail = page.locator('.list-detail:visible').first();
      await expect(detail.getByText('GET /long/item-012', { exact: true })).toBeInViewport();
      expect(await page.evaluate(() => scrollY)).toBe(before);
    }

    await navigate('Skills');
    await page.getByRole('button', { name: /^read-tasks / }).click();
    await expect(page.getByRole('table').getByRole('columnheader', { name: 'Task' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Inspect' })).toContainText('Ready');
    await expect(page.locator('.markdown input[type=checkbox]').first()).toBeChecked();
    await expect(page.locator('.markdown del')).toHaveText('obsolete');
    await page.locator('.markdown sup a').click();
    await expect(page.locator('.markdown .footnotes')).toContainText('This is the reference note.');
    await expect(page.locator('.markdown script')).toHaveCount(0);
    await page
      .locator('.list-detail:visible')
      .first()
      .screenshot({ path: info.outputPath('markdown-gfm.png') });

    await navigate('Wiki');
    await page.getByTestId('wiki-preview').click();
    const wiki = page.getByRole('region', { name: 'Wiki pages' });
    const tail = wiki.getByRole('button', { name: 'read-tasks', exact: true });
    const reader = page.locator('.wiki-detail');
    await expect(reader.getByRole('heading', { name: 'HTTP API', exact: true })).toBeVisible();
    await page.screenshot({
      path: info.outputPath('wiki-overview.png'),
      style: '.project-path, .desktop-path, .ant-message { visibility: hidden !important }',
    });
    await reader.getByRole('link', { name: 'GET /long/item-000', exact: true }).click();
    await expect(reader.getByRole('heading', { name: 'Definition', exact: true })).toBeVisible();
    await expect(reader.locator('pre code.language-json')).toBeVisible();
    await reader.getByRole('link', { name: /Wiki overview/ }).click();
    await reader.getByRole('link', { name: /^Skills · \d+$/ }).click();
    await expect(reader.getByRole('heading', { name: 'Skills', exact: true })).toBeFocused();
    await page.getByRole('button', { name: /Wiki overview/ }).click();
    const category = page.getByRole('combobox', { name: 'Wiki page category' });
    await category.click();
    await page.getByRole('option', { name: 'Skills', exact: true }).click();
    await expect(wiki.getByRole('button')).toHaveCount(2);
    const search = page.getByRole('textbox', { name: 'Search Wiki pages' });
    await search.fill('unknown-page');
    await expect(wiki.getByRole('button')).toHaveCount(0);
    await search.fill('LOCAL API');
    await expect(tail).toBeVisible();
    await search.clear();
    await category.click();
    await page.getByRole('option', { name: 'All categories', exact: true }).click();
    await expect.poll(() => wiki.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await wiki.evaluate((node) => (node.scrollTop = node.scrollHeight));
    await tail.click();
    await expect(
      page.locator('.wiki-detail').getByRole('heading', { name: 'read-tasks', exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: info.outputPath('wiki-long-list.png') });
    await page.setViewportSize({ width: 600, height: 720 });
    await tail.scrollIntoViewIfNeeded();
    const listPosition = await wiki.evaluate((node) => node.scrollTop);
    await tail.click();
    const back = page.getByRole('button', { name: /Back to list/ });
    await expect(back).toBeInViewport();
    await page.screenshot({
      path: info.outputPath('wiki-narrow.png'),
      style: '.project-path, .desktop-path { visibility: hidden !important }',
    });
    await back.click();
    expect(await wiki.evaluate((node) => node.scrollTop)).toBe(listPosition);
    await expect(tail).toBeFocused();

    await header.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('button', { name: 'About IfaceForge' }).click();
    const about = page.getByRole('dialog', { name: 'About IfaceForge' });
    await expect(about.getByText(/^v\d+\.\d+/)).toBeVisible();
    await expect(about.getByText('Acknowledgements')).toBeVisible();
    await expect(about.getByText('react-markdown · remark-gfm')).toBeVisible();
    await expect(about.getByText(/数链创元（天津）信息技术有限责任公司/)).toBeVisible();
    await expect(about.getByRole('button', { name: 'Project repository' })).toBeVisible();
    await about.screenshot({ path: info.outputPath('about.png') });
    await about.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('dialog', { name: 'Preferences' }).getByRole('button', { name: 'Close' }).click();

    writeFileSync(join(sample.root, '.ifaceforge.json'), '{ malformed configuration');
    await page.getByRole('button', { name: 'Scan status' }).click();
    await expect(popup).toBeInViewport({ ratio: 0.99 });
    await expect(popup.getByRole('button', { name: 'View diagnostics' })).toBeInViewport();
    await page.screenshot({
      path: info.outputPath('scan-actions-narrow.png'),
      animations: 'disabled',
      style: '.project-path, .desktop-path { visibility: hidden !important }',
    });
    await popup.getByRole('button', { name: 'Scan again' }).click();
    await expect(popup.getByText('Scan failed')).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Scan again' })).toHaveClass(/ant-btn-primary/);
    await popup.getByRole('button', { name: 'View diagnostics' }).click();
    await diagnostics.getByRole('button', { name: 'Copy all diagnostics' }).click();
    await expect.poll(copied).toMatch(/\[ERROR\].*\n[\s\S]*\.ifaceforge\.json/);
    assertionsPassed = true;
  } finally {
    try {
      await closeDesktop(app);
      sample.destroy();
    } catch (cleanupError) {
      if (assertionsPassed) throw cleanupError;
    }
  }
});

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
    await expect(page.getByRole('button', { name: 'View catalog' })).toHaveClass(/ant-btn-primary/);
    await page.screenshot({
      path: info.outputPath('desktop-scan.png'),
      style: '.project-path { visibility: hidden !important }',
      scale: 'css',
    });
    await page.getByRole('button', { name: 'Close scan status', exact: true }).click();
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

test('uses desktop controls for source, requests, tests, Wiki and project data', async ({}, info) => {
  test.setTimeout(150_000);
  const sample = fixture('express');
  const service = createServer(taskApp());
  const origin = await address(service);
  const transport = 'http://127.0.0.1:9898';
  const target = origin + '/tasks/42';
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
    await page.getByRole('textbox', { name: 'Container executable', exact: true }).fill('node');
    await page
      .getByRole('textbox', { name: 'Container arguments (one per line)', exact: true })
      .fill('server.mjs');
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
    await closeDesktop(app);
    await close(service);
    sample.destroy();
  }
});

test('reviews launch conflicts and copies a failed MCP startup report', async ({}, info) => {
  test.skip(!process.env.IFG_TEST_DOCKER, 'Requires the local Docker test image');
  const sample = fixture('mcp-isolation');
  sample.write('integrations/codex/.mcp.json', {
    mcpServers: {
      'host-launcher': { command: 'powershell.exe', args: ['-File', './scripts/start.ps1'], cwd: '.' },
      'exits-early': {
        command: 'node',
        args: ['-e', "console.error('Example startup failure');process.exit(23)"],
      },
    },
  });
  sample.write('integrations/codex/scripts/start.ps1', 'Fixture');
  commitFixture(sample.root);
  const app = await boot(sample.data);
  try {
    const page = await app.firstWindow();
    await choose(app, sample.root);
    await page.getByRole('banner').getByRole('button', { name: 'Add project' }).click();
    await page.getByRole('button', { name: 'Scan project', exact: true }).click();
    await page.locator('.scan-panel').getByRole('button', { name: 'Close scan status' }).click();
    await page.getByRole('menuitem', { name: 'MCP', exact: true }).click();
    const target = page.getByRole('combobox', { name: 'MCP service' });
    const chooseTarget = async (name: string) => {
      await target.click();
      await page.locator('.ant-select-item-option:visible').filter({ hasText: name }).click();
    };
    await chooseTarget('host-launcher');
    if (process.env.IFG_TEST_DOCKER_IMAGE)
      await page.getByRole('textbox', { name: 'Local Docker image' }).fill(process.env.IFG_TEST_DOCKER_IMAGE);
    const discover = page.getByRole('button', { name: 'Review launch plan' });
    await discover.click();
    const review = page.getByRole('dialog', { name: 'Review isolated launch' });
    await expect(review).toContainText('This launcher requires Windows');
    await expect(review).toContainText('/workspace/integrations/codex');
    await expect(review.getByRole('button', { name: 'Start and discover' })).toBeDisabled();
    await page.setViewportSize({ width: 600, height: 760 });
    await expect(review.getByRole('button', { name: 'Cancel' })).toBeInViewport();
    await review.screenshot({ path: info.outputPath('mcp-preflight-narrow.png') });
    await review.getByRole('button', { name: 'Cancel' }).click();
    await chooseTarget('exits-early');
    await discover.click();
    await review.getByRole('button', { name: 'Start and discover' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'The isolated MCP service could not start.' });
    await expect(alert).toBeVisible({ timeout: 55_000 });
    await expect(alert.getByText('Container exit code 23')).toBeVisible();
    await expect(alert.getByText('Example startup failure', { exact: true })).toBeVisible();
    await alert.screenshot({ path: info.outputPath('mcp-startup-error.png') });
    await alert.locator('summary').click();
    await expect(alert).toContainText('Example startup failure');
    await expect(alert).toContainText('"exitCode": 23');
    await alert.getByRole('button', { name: 'Copy error details' }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('Example startup failure');
    await expect(page.getByText('Sandbox removed', { exact: true })).toBeVisible();
  } finally {
    try {
      await closeDesktop(app);
    } finally {
      sample.destroy();
    }
  }
});

test('reviews an isolated MCP launch and operates the capability directory and tests', async ({}, info) => {
  test.skip(!process.env.IFG_TEST_DOCKER, 'Requires the local Docker test image');
  test.setTimeout(180_000);
  const sample = fixture('mcp-isolation');
  commitFixture(sample.root);
  const app = await boot(sample.data);
  try {
    const page = await app.firstWindow();
    const header = page.getByRole('banner');
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    await choose(app, sample.root);
    await header.getByRole('button', { name: 'Add project' }).click();
    await button('Scan project').click();
    await page.locator('.scan-panel').getByRole('button', { name: 'Close scan status' }).click();
    await page.getByRole('menuitem', { name: 'MCP', exact: true }).click();
    await page.getByRole('combobox', { name: 'MCP service' }).click();
    await page.locator('.ant-select-item-option:visible').filter({ hasText: 'sample-stdio' }).click();
    const configured = process.env.IFG_TEST_DOCKER_IMAGE;
    if (configured) await page.getByRole('textbox', { name: 'Local Docker image' }).fill(configured);
    await button('Review launch plan').click();
    const review = page.getByRole('dialog', { name: 'Review isolated launch' });
    await expect(review).toContainText('server.mjs');
    await expect(review).toContainText('sha256:');
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(button('echo')).toHaveCount(0);
    await button('Review launch plan').click();
    await button('Start and discover').click();
    await expect(page.getByText('Sandbox removed', { exact: true })).toBeVisible({ timeout: 60_000 });
    const directory = page.getByRole('region', { name: 'MCP capability list' });
    const serviceDetails = page.locator('summary').filter({ hasText: /^Service details$/ });
    await serviceDetails.click();
    await expect(serviceDetails.locator('..')).toHaveAttribute('open', '');
    await serviceDetails.click();
    await page.getByRole('textbox', { name: 'Search MCP directory' }).fill('Returns the input');
    await expect(directory.getByRole('button')).toHaveCount(1);
    await directory.getByRole('button', { name: 'echo' }).click();
    await page.getByRole('tab', { name: 'Details' }).click();
    await page
      .locator('summary')
      .filter({ hasText: /^Input schema$/ })
      .click();
    await expect(page.locator('.mcp-inspector pre.code').filter({ hasText: '"required"' }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Test', exact: true }).click();
    await page.getByRole('textbox', { name: 'value *', exact: true }).fill('desktop result');
    await button('Call tool').click();
    await expect(
      page.locator('.mcp-inspector pre.code:visible').filter({ hasText: 'desktop result' }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(button('Call tool')).toBeEnabled();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: info.outputPath('sandbox-mcp.png'),
      animations: 'disabled',
      scale: 'css',
      style: '.project-path, .desktop-path { visibility: hidden !important }',
    });
    await button('Save as case').click();
    await page.getByRole('textbox', { name: 'Case ID' }).fill('isolated-echo');
    await page.getByRole('textbox', { name: 'Case name' }).fill('Isolated echo');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await button('Resources').click();
    await directory.getByRole('button', { name: 'task', exact: true }).click();
    await button('Read resource').click();
    await expect(page.locator('.mcp-inspector').getByText('Read task://42', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await button('Resource templates').click();
    await directory.getByRole('button', { name: 'task-template', exact: true }).click();
    await page.getByRole('textbox', { name: /^id/ }).fill('43');
    await expect(page.getByRole('textbox', { name: 'Resource URI', exact: true })).toHaveValue('task://43');
    await button('Read resource').click();
    await expect(page.locator('.mcp-inspector').getByText('Read task://43', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await button('Prompts').click();
    await button('task-summary').click();
    await page.getByRole('textbox', { name: 'title *' }).fill('desktop prompt');
    await button('Get prompt').click();
    await expect(
      page.locator('.mcp-inspector .mcp-content').getByText('desktop prompt', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: info.outputPath('sandbox-mcp-prompt.png') });
    await page.setViewportSize({ width: 600, height: 720 });
    await directory.getByRole('button', { name: 'task-summary' }).click();
    const back = page.getByRole('button', { name: /Back to list/ });
    await expect(back).toBeInViewport();
    await back.click();
    await expect(directory.getByRole('button', { name: 'task-summary' })).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.reload();
    await page.getByRole('menuitem', { name: 'MCP', exact: true }).click();
    await page.getByRole('combobox', { name: 'MCP service' }).click();
    await page.locator('.ant-select-item-option:visible').filter({ hasText: 'sample-stdio' }).click();
    await expect(directory.getByRole('button', { name: 'echo', exact: true })).toBeVisible();
  } finally {
    await closeDesktop(app);
    sample.destroy();
  }
});

test('reviews the local MCP process and confirms a test at a narrow width', async ({}, info) => {
  test.setTimeout(180_000);
  const sample = fixture('mcp-isolation');
  sample.write('.mcp.json', {
    mcpServers: {
      'desktop-native': { command: process.execPath, args: ['server.mjs'], protocolVersion: '2025-11-25' },
      'missing-settings': { command: process.execPath, args: ['missing-settings.mjs'] },
    },
  });
  writeFileSync(
    join(sample.root, 'missing-settings.mjs'),
    "console.error('Required local settings file was not found.');\nprocess.exitCode = 1;\n",
  );
  writeFileSync(join(sample.root, 'method.go'), 'package demo\nvar operation = "tools/list"\n');
  commitFixture(sample.root);
  const app = await boot(sample.data);
  try {
    const page = await app.firstWindow();
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    await choose(app, sample.root);
    await page.getByRole('banner').getByRole('button', { name: 'Add project' }).click();
    await button('Scan project').click();
    await page.locator('.scan-panel').getByRole('button', { name: 'Close scan status' }).click();
    await page.getByRole('menuitem', { name: 'MCP', exact: true }).click();
    await page.setViewportSize({ width: 650, height: 750 });
    const scanRecords = page.locator('summary').filter({ hasText: /^Project scan records$/ });
    await scanRecords.click();
    await expect(page.getByRole('button', { name: /tools\/list/ })).toBeVisible();
    await scanRecords.click();
    await page.getByRole('combobox', { name: 'MCP service' }).click();
    await page.locator('.ant-select-item-option:visible').filter({ hasText: 'desktop-native' }).click();
    const environment = page.getByRole('combobox', { name: 'Run environment' });
    await expect(page.getByRole('textbox', { name: 'Local Docker image' })).toBeVisible();
    await environment.click();
    await expect(page.getByRole('option')).toHaveText(['Docker · Linux', 'Local process']);
    await page.getByRole('option', { name: 'Local process', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Local Docker image' })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'MCP protocol version' }).click();
    await page
      .locator('.ant-select-item-option:visible')
      .filter({ hasText: /^2025-11-25$/ })
      .click();
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
    await expect
      .poll(() => page.locator('.mcp-launch-grid').evaluate((node) => node.scrollWidth <= node.clientWidth))
      .toBe(true);
    await page.screenshot({
      path: info.outputPath('mcp-launch-narrow.png'),
      style: '.project-path, .desktop-path { visibility: hidden !important }',
    });
    await button('Review launch plan').click();
    const dialog = page.getByRole('dialog', { name: 'Review local launch' });
    await expect(dialog).toContainText('server.mjs');
    await expect(dialog).toContainText('2025-11-25');
    await dialog.screenshot({ path: info.outputPath('mcp-native-review.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await button('Review launch plan').click();
    await dialog.getByRole('button', { name: 'Start and discover' }).click();
    await expect(page.getByText('Local process closed', { exact: true })).toBeVisible({ timeout: 90_000 });
    const list = page.getByRole('region', { name: 'MCP capability list' });
    await expect(list.getByRole('button', { name: 'echo', exact: true })).toBeVisible();
    await expect(button('Local results')).toHaveAttribute('aria-pressed', 'true');
    await button('Isolated results').click();
    await expect(list).toHaveCount(0);
    await expect(page.getByText('No results saved for this service and run type.')).toBeVisible();
    await expect(page.locator('.mcp-launch-grid')).toContainText('Local process');
    await button('Local results').click();
    await list.getByRole('button', { name: 'echo', exact: true }).click();
    await page.getByRole('tab', { name: 'Details' }).click();
    const details = page.locator('summary').filter({ hasText: /^Input schema$/ });
    await details.click();
    await expect(details.locator('..')).toHaveAttribute('open', '');
    await details.click();
    await page.getByRole('tab', { name: 'Test', exact: true }).click();
    await page.getByRole('textbox', { name: 'value *', exact: true }).fill('native desktop check');
    await button('Call tool').click();
    await expect(dialog).toContainText('native desktop check');
    await dialog.getByRole('button', { name: 'Start and test' }).click();
    await expect(
      page.locator('.mcp-inspector pre.code:visible').filter({ hasText: 'native desktop check' }).first(),
    ).toBeVisible({ timeout: 90_000 });
    await page.screenshot({ path: info.outputPath('mcp-native-result.png') });

    await page.getByRole('combobox', { name: 'MCP service' }).click();
    await page.locator('.ant-select-item-option:visible').filter({ hasText: 'missing-settings' }).click();
    await button('Review launch plan').click();
    await dialog.getByRole('button', { name: 'Start and discover' }).click();
    const failure = page.getByRole('alert').filter({ hasText: 'The local MCP process could not start.' });
    await expect(failure.getByText('Local process exit code 1', { exact: true })).toBeVisible();
    await expect(failure.getByText('Required local settings file was not found.', { exact: true })).toBeVisible();
    await failure.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath('mcp-native-startup-error.png'),
      animations: 'disabled',
      style: '.project-path, .desktop-path { visibility: hidden !important }',
    });
    await failure.locator('summary').click();
    await failure.getByRole('button', { name: 'Copy error details' }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('MCP_NATIVE_FAILED');
  } finally {
    await closeDesktop(app);
    sample.destroy();
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
    'from urllib.parse import urlsplit\ndef dispatch(handler):\n    route = urlsplit(handler.path)\n    if route.path == configured_path and handler.command == "GET":\n        return route\n',
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
      .filter({ hasText: /^\d+ unresolved route diagnostics,/ })
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
