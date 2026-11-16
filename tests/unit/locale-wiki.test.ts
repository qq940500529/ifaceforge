import { expect, it } from 'vitest';
import { dictionaries, translator } from '../../src/web/i18n.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProject } from '../../src/app/project.js';
import { scanProject } from '../../src/app/catalog.js';
import { openProjectDatabase } from '../../src/storage/database.js';
import { Repository } from '../../src/storage/repository.js';
import { buildWiki, previewWiki, putNote } from '../../src/app/wiki.js';
import { backupData, restoreData } from '../../src/app/maintenance.js';

it('keeps locale keys and placeholders in sync', () => {
  const en = Object.entries(dictionaries.en);
  expect(Object.keys(dictionaries['zh-CN']).sort()).toEqual(Object.keys(dictionaries.en).sort());
  for (const [key, value] of en) {
    const fields = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    expect(fields(dictionaries['zh-CN'][key as keyof typeof dictionaries.en])).toEqual(fields(value));
  }
  expect(translator('zh-CN')('snapshot', { id: 'abc' })).toContain('abc');
});

it('merges notes, preserves unowned documents and restores the database and notes', async () => {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'ifg Wiki 测试 '));
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(join(root, 'read'));
  writeFileSync(join(root, 'read', 'SKILL.md'), '---\nname: read\ndescription: Read\n---\n# Body');
  const project = resolveProject(root);
  const db = openProjectDatabase(project);
  const repository = new Repository(db);
  try {
    const scan = scanProject(project, repository, { includeUntracked: true });
    const entity = scan.entities[0];
    putNote(project, entity.id, '人工内容');
    const out = join(root, 'output');
    mkdirSync(out);
    writeFileSync(join(out, 'external.md'), 'external');
    const built = buildWiki(project, repository, { out, locale: 'zh-CN' });
    expect(readFileSync(join(out, built.catalog.items[0].page), 'utf8')).toContain('人工内容');
    expect(readFileSync(join(out, 'external.md'), 'utf8')).toBe('external');
    expect(previewWiki(project, repository, { out, locale: 'zh-CN' }).changed).toEqual([]);
    expect(previewWiki(project, repository, { out, locale: 'en' }).changed).toContain('README.md');
    writeFileSync(join(out, 'README.md'), 'user change');
    expect(() => buildWiki(project, repository, { out })).toThrow(/unowned or edited/);
    const backup = join(root, 'workbench-backup.json');
    repository.set('locale', 'zh-CN');
    await backupData(project, repository, backup);
    repository.set('locale', 'en');
    putNote(project, entity.id, 'new');
    expect(() => restoreData(project, repository, backup)).toThrow(/replace existing/);
    expect(restoreData(project, repository, backup, true).notes).toBe(1);
    expect(repository.setting('locale')).toBe('zh-CN');
    expect(previewWiki(project, repository).pages[built.catalog.items[0].page]).toContain('人工内容');
  } finally {
    db.close();
    if (dirname(realpathSync(root)) !== parent) throw Error('Unexpected fixture path');
    rmSync(root, { recursive: true });
  }
});
