import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } from 'electron';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { AppError, failure, invalid } from '../app/errors.js';
import { dataHome } from '../app/project.js';
import type { CommandInput } from '../app/workbench.js';
import type { EngineRequest, FileKind, Result } from './protocol.js';
import type { Locale } from '../app/config.js';
import { ensureService, serviceRequest } from './service-client.js';

import { projectInfo } from '../app/about.js';

const origin = 'ifaceforge://workbench';
const page = origin + '/index.html';
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const repositoryUrl = projectInfo.repository;
const releaseUrl = repositoryUrl + '/releases';
const contentPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
protocol.registerSchemesAsPrivileged([
  { scheme: 'ifaceforge', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const ui = new URL('../../src/desktop/preload.cjs', import.meta.url);
const preload = fileURLToPath(ui);
let window: BrowserWindow | undefined;
let quitting = false;
const candidates = new Map<string, string>();
const selectedFiles = new Map<string, { path: string; project: string; kind: FileKind }>();
const unavailable: Result<never> = {
  ok: false,
  error: { code: 'ENGINE_UNAVAILABLE', message: 'The workspace engine is unavailable.' },
};

async function send(request: EngineRequest): Promise<Result<unknown>> {
  if (quitting) return unavailable;
  const existing = await serviceRequest(request);
  if (existing) return existing;
  await ensureService();
  return (await serviceRequest(request)) ?? unavailable;
}
function safe<T>(data: T): Result<T> {
  return { ok: true, data };
}
function handle<Args extends unknown[]>(method: string, handler: (...args: Args) => Promise<Result<unknown>>) {
  ipcMain.handle('ifaceforge:' + method, async (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame?.url !== page
    ) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'Invalid workspace origin' } };
    }
    try {
      return await handler(...(args as Args));
    } catch (exception) {
      const { code, message, details } = failure(exception);
      return { ok: false, error: { code, message, details } };
    }
  });
}

function addHandlers() {
  handle('about', async () => safe({ version: app.getVersion() }));
  handle('repository', async () => {
    await shell.openExternal(repositoryUrl);
    return safe(true);
  });
  handle('state', () => send({ method: 'state' }));
  handle('select', (project: string) => send({ method: 'select', project }));
  handle('locale', (locale: Locale) => send({ method: 'locale', locale }));
  handle('tasks', () => send({ method: 'tasks' }));
  handle('scanDetails', (project: string, task: string) => {
    if (typeof project !== 'string' || !project || typeof task !== 'string' || !task)
      invalid('Expected project and scan task identifiers');
    return send({ method: 'task show', project, task });
  });
  handle('cancelScan', (project: string, task: string) => send({ method: 'scan cancel', project, task }));
  handle('chooseProject', async () => {
    const picked = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return safe(null);
    const examined = await send({ method: 'inspect', path: picked.filePaths[0] });
    if (!examined.ok) return examined;
    const candidate = examined.data as { selected: string; root: string };
    const token = randomUUID();
    candidates.clear();
    candidates.set(token, candidate.root);
    return safe({ ...candidate, token });
  });
  handle('register', async (token: string, project?: string) => {
    const path = candidates.get(token);
    if (!path) invalid('Choose a project directory first');
    candidates.delete(token);
    return send(project ? { method: 'relocate', path, project } : { method: 'add', path });
  });
  handle('remove', (project: string, erase: boolean) =>
    send({ method: erase === true ? 'delete' : 'hide', project }),
  );
  handle('chooseFile', async (project: string, kind: FileKind) => {
    if (!['wiki', 'backup', 'restore', 'openapi'].includes(kind)) invalid('Unsupported file selection');
    const filter: Electron.FileFilter[] = [{ name: 'IfaceForge JSON', extensions: ['json'] }];
    let path: string | undefined;
    if (kind === 'backup') {
      const picked = await dialog.showSaveDialog(window!, {
        defaultPath: 'ifaceforge-backup.json',
        filters: filter,
      });
      if (!picked.canceled) path = picked.filePath;
    } else {
      const picked = await dialog.showOpenDialog(window!, {
        properties: kind === 'wiki' ? ['openDirectory', 'createDirectory'] : ['openFile'],
        filters:
          kind === 'restore'
            ? filter
            : kind === 'openapi'
              ? [{ name: 'OpenAPI', extensions: ['json', 'yaml', 'yml'] }]
              : undefined,
      });
      if (!picked.canceled) path = picked.filePaths[0];
    }
    if (!path) return safe(null);
    for (const [token, existing] of selectedFiles) {
      if (existing.project === project && existing.kind === kind) selectedFiles.delete(token);
    }
    const token = randomUUID();
    selectedFiles.set(token, { path, project, kind });
    return safe({ path, token });
  });
  handle('command', async (project: string, name: string, input: CommandInput) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected command parameters');
    if (JSON.stringify(input).length > 4 * 1024 * 1024) invalid('Command parameters are too large');
    const fileKind: FileKind | undefined =
      name === 'data backup'
        ? 'backup'
        : name === 'data restore'
          ? 'restore'
          : name === 'wiki build' || name === 'wiki preview'
            ? 'wiki'
            : name === 'api import' && input.fileToken
              ? 'openapi'
              : undefined;
    if (fileKind) {
      const { fileToken, ...other } = input;
      input = { ...other, out: undefined, file: undefined };
      if (fileToken || fileKind !== 'wiki') {
        const entry = fileToken ? selectedFiles.get(fileToken) : undefined;
        if (!entry || entry.project !== project || entry.kind !== fileKind)
          invalid('Choose a destination or file first');
        if (fileKind === 'restore' || fileKind === 'openapi') input.file = entry.path;
        else input.out = entry.path;
      }
    }
    const result = await send({ method: 'command', name, project, input });
    if (result.ok && name === 'wiki open') {
      const { out } = result.data as { out: string };
      const error = await shell.openPath(out);
      if (error) throw new AppError('OPEN_FAILED', error);
    }
    return result;
  });
  handle('download', async (name: string, text: string) => {
    if (
      typeof name !== 'string' ||
      typeof text !== 'string' ||
      text.length > 16 * 1024 * 1024 ||
      !name ||
      name !== basename(name) ||
      /[:<>|?*]/.test(name)
    )
      invalid('Invalid export');
    const extension = extname(name).slice(1);
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: name,
      filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
    });
    if (result.canceled || !result.filePath) return safe(false);
    await writeFile(result.filePath, text, { mode: 0o600 });
    return safe(true);
  });
  handle('copy', async (text: string) => {
    if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) invalid('Invalid clipboard text');
    clipboard.writeText(text);
    return safe(true);
  });
  handle('releases', async () => {
    await shell.openExternal(releaseUrl);
    return safe(true);
  });
}

function createWindow() {
  const next = new BrowserWindow({
    show: false,
    title: 'IfaceForge',
    width: 1280,
    height: 850,
    minWidth: 600,
    minHeight: 520,
    backgroundColor: '#f4f6fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });
  window = next;
  next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  next.webContents.on('will-navigate', (event) => event.preventDefault());
  next.webContents.on('will-attach-webview', (event) => event.preventDefault());
  next.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  next.webContents.session.setPermissionCheckHandler(() => false);
  next.once('ready-to-show', () => next.show());
  next.on('closed', () => {
    window = undefined;
  });
  void next.loadURL(page);
}

app.setName('IfaceForge');
app.setPath('userData', resolve(dataHome(), 'desktop'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('activate', () => {
    if (!window && !quitting) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  void app.whenReady().then(() => {
    protocol.handle('ifaceforge', async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'workbench' || !/^\/(?:index\.html|assets\/[\w.-]+)$/.test(url.pathname)) {
        return new Response(null, { status: 404 });
      }
      const asset = await net.fetch(pathToFileURL(join(webRoot, url.pathname.slice(1))).href);
      const headers = new Headers(asset.headers);
      headers.set('Content-Security-Policy', contentPolicy);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(asset.body, { status: asset.status, headers });
    });
    addHandlers();
    createWindow();
  });
}
