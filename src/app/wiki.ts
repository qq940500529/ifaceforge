import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectPaths } from './project.js';
import type { Repository } from '../storage/repository.js';
import type { Locale } from './config.js';
import type { Kind, Snapshot } from '../scanner/model.js';
import { activeSnapshot, getSnapshot } from './catalog.js';
import { AppError, invalid } from './errors.js';
import { digest, parseJson, projectFile } from './files.js';
import { Bindings } from '../protocols/variables.js';

const manifestName = '.ifaceforge-wiki.json';
const generatedPage = /^(?:api|mcp|skills)\/[a-f0-9]{24}\.md$/;
const safePage = (path: string) => path === 'README.md' || path === 'catalog.json' || generatedPage.test(path);
const noteName = (id: string) => encodeURIComponent(id) + '.md';

interface Manifest {
  schemaVersion: 1;
  files: Record<string, string>;
}
interface WikiOptions {
  snapshot?: string;
  out?: string;
  locale?: Locale;
}
interface WikiRecord {
  id: string;
  snapshot: string;
  locale: Locale;
  out: string;
  digest: string;
  created: string;
  status: 'complete';
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function noteDirectory(project: ProjectPaths) {
  return projectFile(project.data, 'wiki-notes', false);
}

function notePath(project: ProjectPaths, id: string) {
  if (!id || id.length > 1024) invalid('Invalid capability ID');
  return projectFile(project.data, join('wiki-notes', noteName(id)), false);
}

export function putNote(project: ProjectPaths, id: string, text: string) {
  if (Buffer.byteLength(text) > 1024 * 1024) invalid('Wiki note exceeds 1 MiB');
  const path = notePath(project, id);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), randomUUID() + '.tmp');
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { id, text };
}

export function getNote(project: ProjectPaths, id: string) {
  const path = notePath(project, id);
  return { id, text: existsSync(path) ? readText(path) : '' };
}

function manifest(out: string): Manifest {
  const path = projectFile(out, manifestName, false);
  if (!existsSync(path)) return { schemaVersion: 1, files: {} };
  const value = parseJson(readText(path)) as Manifest;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !value.files ||
    typeof value.files !== 'object' ||
    Array.isArray(value.files) ||
    Object.entries(value.files).some(
      ([key, hash]) => !safePage(key) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash),
    )
  ) {
    invalid('Invalid Wiki manifest');
  }
  return value;
}

function markdownTitle(text: string) {
  return text.replace(/[\r\n]/g, ' ').replace(/[\\[\]<>*_#`~&|!]/g, '\\$&');
}

function codeBlock(language: string, text: string) {
  const fence = '`'.repeat((text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length + 1), 3));
  return fence + language + '\n' + text + '\n' + fence;
}

const wikiKinds = ['api', 'mcp', 'skill'] as const;
const wikiLabels: Record<Kind, [string, string]> = {
  api: ['HTTP API', 'HTTP API'],
  mcp: ['MCP', 'MCP'],
  skill: ['Skills', '技能'],
};

function snapshotFor(repository: Repository, id?: string) {
  if (!id && repository.list<Snapshot>('scans')[0]?.complete === false) {
    throw new AppError('INCOMPLETE_SCAN', 'Select a complete snapshot explicitly');
  }
  const snapshot = id ? getSnapshot(repository, id) : activeSnapshot(repository);
  if (!snapshot?.complete) throw new AppError('NO_SNAPSHOT', 'A complete scan is required');
  return snapshot;
}

export function previewWiki(project: ProjectPaths, repository: Repository, options: WikiOptions = {}) {
  const snapshot = snapshotFor(repository, options.snapshot);
  const locale = options.locale ?? 'en';
  if (locale !== 'en' && locale !== 'zh-CN') invalid('Invalid Wiki locale');
  const out = options.out ? resolve(options.out) : join(project.data, 'wiki');
  const zh = locale === 'zh-CN';
  const pages: Record<string, string> = {};
  const notes = noteDirectory(project);
  const orphanNotes = new Set(existsSync(notes) ? readdirSync(notes).filter((file) => file.endsWith('.md')) : []);
  const bindings = new Bindings();
  const items = snapshot.entities.map((entity) => {
    const path = (entity.kind === 'skill' ? 'skills' : entity.kind) + '/' + digest(entity.id).slice(0, 24) + '.md';
    const sources = [...new Set(entity.observations.flatMap((entry) => (entry.path ? [entry.path] : [])))];
    const title = markdownTitle(entity.name);
    const note = getNote(project, entity.id).text;
    orphanNotes.delete(noteName(entity.id));
    const body = entity.observations[0].definition.body;
    const raw = JSON.stringify(bindings.redact(entity.observations.map((entry) => entry.definition)), null, 2);
    const details = entity.kind === 'skill' ? String(body ?? '') : codeBlock('json', raw);
    const sourceRows = sources.map((source) => '- ' + markdownTitle(source)).join('\n');
    const example =
      entity.kind === 'api'
        ? 'ifg api export '
        : entity.kind === 'skill'
          ? 'ifg skill show '
          : 'ifg catalog show ';
    pages[path] =
      [
        '# ' + title,
        '[← ' + (zh ? 'Wiki 总览' : 'Wiki overview') + '](../README.md)',
        entity.summary,
        [
          '| ' + (zh ? '类型' : 'Category') + ' | ' + (zh ? '定义摘要' : 'Definition digest') + ' |',
          '| --- | --- |',
          '| ' + wikiLabels[entity.kind][zh ? 1 : 0] + ' | `' + entity.version + '` |',
        ].join('\n'),
        sourceRows ? '## ' + (zh ? '来源' : 'Sources') + '\n\n' + sourceRows : '',
        details
          ? '## ' +
            (entity.kind === 'skill' ? (zh ? '技能文档' : 'Skill documentation') : zh ? '定义' : 'Definition') +
            '\n\n' +
            details
          : '',
        '## ' +
          (zh ? '命令行' : 'Command line') +
          '\n\n' +
          codeBlock('sh', example + "'" + entity.id.replaceAll("'", "'\"'\"'") + "'"),
        note ? '## ' + (zh ? '人工说明' : 'Notes') + '\n\n' + note : '',
      ]
        .filter(Boolean)
        .join('\n\n') + '\n';
    return { id: entity.id, kind: entity.kind, name: entity.name, summary: entity.summary, sources, page: path };
  });
  const catalog = { schemaVersion: 1, snapshot: snapshot.id, locale, items };
  const groups = wikiKinds
    .map((kind) => ({
      label: wikiLabels[kind][zh ? 1 : 0],
      items: items.filter((item) => item.kind === kind),
    }))
    .filter((group) => group.items.length);
  pages['README.md'] =
    [
      '# ' + (zh ? '接口工坊 Wiki' : 'IfaceForge Wiki'),
      (zh ? '扫描快照' : 'Scan snapshot') + ' `' + snapshot.id + '`',
      groups
        .map(
          ({ label, items }) =>
            '[' + label + ' · ' + items.length + '](#' + label.toLowerCase().replaceAll(' ', '-') + ')',
        )
        .join(' '),
      ...groups.map((group) =>
        [
          '## ' + group.label,
          '',
          '| ' + (zh ? '名称' : 'Name') + ' | ' + (zh ? '说明' : 'Description') + ' |',
          '| --- | --- |',
          ...group.items.map(
            (item) =>
              '| [' +
              markdownTitle(item.name) +
              '](' +
              item.page +
              ') | ' +
              (markdownTitle(item.summary.trim()) || '—') +
              ' |',
          ),
        ].join('\n'),
      ),
      items.length ? '' : zh ? '此快照没有可记录的能力。' : 'This snapshot has no capabilities to document.',
    ]
      .filter(Boolean)
      .join('\n\n') + '\n';
  pages['catalog.json'] = JSON.stringify(catalog, null, 2) + '\n';
  const files = Object.fromEntries(Object.entries(pages).map(([path, text]) => [path, digest(text)]));
  const old = existsSync(out) ? manifest(out) : { files: {} as Record<string, string> };
  const changed = Object.keys(files).filter(
    (path) => files[path] !== old.files[path] || !existsSync(projectFile(out, path, false)),
  );
  const removed = Object.keys(old.files).filter((path) => !Object.hasOwn(files, path));
  const conflicts = existsSync(out)
    ? Object.keys(pages).filter(
        (path) =>
          existsSync(projectFile(out, path, false)) &&
          (!Object.hasOwn(old.files, path) || digest(readText(projectFile(out, path))) !== old.files[path]),
      )
    : [];
  return {
    snapshot: snapshot.id,
    locale,
    out,
    catalog,
    pages,
    changed,
    removed,
    conflicts,
    orphanNotes: [...orphanNotes].sort(),
    missingSources: snapshot.diagnostics,
    manifest: { schemaVersion: 1 as const, files },
  };
}

export function buildWiki(project: ProjectPaths, repository: Repository, options: WikiOptions = {}) {
  const preview = previewWiki(project, repository, options);
  if (preview.conflicts.length)
    throw new AppError('WIKI_CONFLICT', 'Output contains an unowned or edited file', 3, preview.conflicts);
  const out = preview.out;
  if (!options.out) projectFile(project.data, relative(project.data, out), false);
  mkdirSync(dirname(out), { recursive: true });
  const stage = mkdtempSync(join(dirname(out), '.ifg-wiki-'));
  try {
    for (const [path, contents] of Object.entries(preview.pages)) {
      const target = join(stage, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    for (const item of preview.catalog.items) {
      if (!generatedPage.test(item.page) || !existsSync(join(stage, item.page)))
        throw Error('Broken generated Wiki link');
    }
    writeFileSync(join(stage, manifestName), JSON.stringify(preview.manifest, null, 2) + '\n');
    const old = existsSync(out) ? manifest(out) : { files: {} as Record<string, string> };
    for (const removed of preview.removed) {
      const path = projectFile(out, removed, false);
      if (existsSync(path) && digest(readText(path)) !== old.files[removed]) {
        throw new AppError('WIKI_CONFLICT', 'Former Wiki page has been edited', 3, { path: removed });
      }
    }
    const unowned =
      existsSync(out) &&
      readdirSync(out, { recursive: true, withFileTypes: true }).some((entry) => {
        const path = relative(out, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
        return entry.isDirectory()
          ? !['api', 'mcp', 'skills'].includes(path)
          : path !== manifestName && !Object.hasOwn(old.files, path);
      });
    if (!options.out && !unowned) {
      const previous = join(dirname(out), '.ifg-previous-' + randomUUID());
      const exists = existsSync(out);
      if (exists) renameSync(out, previous);
      try {
        renameSync(stage, out);
      } catch (error) {
        if (exists) renameSync(previous, out);
        throw error;
      }
      if (exists && dirname(previous) === dirname(out)) rmSync(previous, { recursive: true, force: true });
    } else {
      mkdirSync(out, { recursive: true });
      for (const path of [...Object.keys(preview.pages), manifestName]) {
        const target = projectFile(out, path, false);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(join(stage, path), target);
      }
      for (const removed of preview.removed) rmSync(projectFile(out, removed, false), { force: true });
    }
  } finally {
    if (dirname(stage) === dirname(out) && resolve(stage) !== resolve(out))
      rmSync(stage, { recursive: true, force: true });
  }
  const record: WikiRecord = {
    id: randomUUID(),
    snapshot: preview.snapshot,
    locale: preview.locale,
    out,
    digest: digest(JSON.stringify(preview.manifest)),
    created: new Date().toISOString(),
    status: 'complete',
  };
  repository.put('wiki_exports', record.id, record);
  return { ...record, catalog: preview.catalog, changed: preview.changed, removed: preview.removed };
}

export function readWiki(repository: Repository, id: string, page?: string) {
  const record = repository.require<WikiRecord>('wiki_exports', id);
  if (!page) return record;
  if (isAbsolute(page) || !safePage(page)) invalid('Invalid Wiki page path');
  const ownership = manifest(record.out);
  if (!Object.hasOwn(ownership.files, page)) throw new AppError('NOT_FOUND', 'Wiki page not found');
  return { ...record, page, text: readText(projectFile(record.out, page)) };
}
