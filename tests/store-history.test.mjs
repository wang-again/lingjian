import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';

const now = () => new Date().toISOString();
const snapshot = (id, html) => ({ id, title: '版本', html, at: now(), label: '保存前' });

async function legacyWorkspace(directory, html) {
  const document = {
    id: 'doc-a', title: '旧文档', html, sources: [], templateId: null,
    history: [snapshot('h1', '<p>更早的版本</p>'), snapshot('h2', '<p>上一版</p>')],
    revision: 3, createdAt: now(), updatedAt: now()
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, documents: [document], providers: [], activeProviderId: null }, null, 2));
  return document;
}

test('旧版内联历史在首次启动时拆分到 history/，并保留主文件原样副本', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-store-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = await legacyWorkspace(directory, '<p>当前正文</p>');

  const store = await createStore(directory);
  assert.equal(store.migrated, true, '应报告发生过迁移');
  assert.equal(store.state.documents[0].history.length, 2, '内存里仍保留完整历史');

  const main = await readFile(join(directory, 'workspace.json'), 'utf8');
  assert.ok(!main.includes('"history"'), '主文件不再写入 history 字段');
  const index = JSON.parse(main);
  assert.equal(index.documents[0].html, '<p>当前正文</p>');
  assert.equal(index.documents[0].revision, 3);

  const split = JSON.parse(await readFile(join(directory, 'history', 'doc-a.json'), 'utf8'));
  assert.deepEqual(split, legacy.history);

  const backup = JSON.parse(await readFile(join(directory, 'workspace.json.v1.bak'), 'utf8'));
  assert.equal(backup.documents[0].history.length, 2, '原始文件必须原样保留');
});

test('保存正文不再重写历史：主文件体积不随历史增长', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-store-size-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await legacyWorkspace(directory, '<p>起点</p>');
  const store = await createStore(directory);

  const save = i => store.updateDocuments(documents => {
    const document = documents[0];
    document.html = `<p>${'正'.repeat(20_000)}</p>`;
    document.revision += 1;
    document.history = [snapshot(`h-${i}`, `<p>${'旧'.repeat(20_000)}</p>`), ...document.history].slice(0, 20);
    return documents;
  });

  await save(1);
  const baseline = (await stat(join(directory, 'workspace.json'))).size;
  for (let i = 2; i <= 8; i++) await save(i);

  const mainSize = (await stat(join(directory, 'workspace.json'))).size;
  const historySize = (await stat(join(directory, 'history', 'doc-a.json'))).size;
  assert.ok(mainSize <= baseline + 2_000, `主文件不应随历史增长：${baseline} → ${mainSize} 字节`);
  assert.ok(historySize > 150_000, `历史单独存放，实际 ${historySize} 字节`);
  assert.ok(historySize > mainSize * 3, '历史体积应明显大于主文件');
});

test('普通保存不重写历史文件，只有新增快照时才写入', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-store-untouched-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await legacyWorkspace(directory, '<p>起点</p>');
  const store = await createStore(directory);
  const file = join(directory, 'history', 'doc-a.json');
  const before = (await stat(file)).mtimeMs;

  await new Promise(resolve => setTimeout(resolve, 30));
  await store.updateDocuments(documents => { documents[0].html = '<p>只改正文</p>'; documents[0].revision += 1; return documents; });
  assert.equal((await stat(file)).mtimeMs, before, '未新增快照的自动保存不应重写历史文件');

  await store.updateDocuments(documents => {
    documents[0].history = [snapshot('h-new', '<p>本轮快照</p>'), ...documents[0].history];
    documents[0].revision += 1;
    return documents;
  });
  assert.ok((await stat(file)).mtimeMs > before, '新增快照后必须写入历史文件');
  assert.equal((await store.state.documents[0].history).length, 3);
});

test('删除文档时一并清理历史文件', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-store-delete-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await legacyWorkspace(directory, '<p>x</p>');
  const store = await createStore(directory);
  await store.updateDocuments(documents => documents.filter(document => document.id !== 'doc-a'));
  await assert.rejects(readFile(join(directory, 'history', 'doc-a.json'), 'utf8'), error => error.code === 'ENOENT');
});

test('历史文件缺失时按空历史启动，不阻断工作区', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-store-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await legacyWorkspace(directory, '<p>x</p>');
  await createStore(directory);
  await rm(join(directory, 'history', 'doc-a.json'), { force: true });

  const reopened = await createStore(directory);
  assert.deepEqual(reopened.state.documents[0].history, []);
  assert.equal(reopened.state.documents[0].html, '<p>x</p>');
});
