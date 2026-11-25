import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { usage } from '../lib/admin-http.mjs';

const temporary = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-meta-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
};

test('每次保存后 meta.json 与工作区大小、mtime、计数保持一致', async t => {
  const directory = await temporary(t);
  const store = await createStore(directory);
  await store.updateDocuments(documents => {
    documents[0].html = `<p>${'文'.repeat(5000)}</p>`;
    documents[0].revision += 1;
    return documents;
  });

  const info = await stat(join(directory, 'workspace.json'));
  const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'));
  assert.equal(meta.version, 1);
  assert.equal(meta.documents, 1);
  assert.equal(meta.providers, 0);
  assert.equal(meta.sourceSize, info.size);
  assert.equal(Math.round(meta.sourceMtimeMs), Math.round(info.mtimeMs));
});

test('管理端统计优先采用 meta，不解析整份工作区', async t => {
  const directory = await temporary(t);
  // 故意写入无法解析的内容：若实现退回 JSON.parse，documents 会变成 0 且 partial 为 true。
  await writeFile(join(directory, 'workspace.json'), '{ this is not json ');
  const info = await stat(join(directory, 'workspace.json'));
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ version: 1, documents: 7, providers: 3, sourceSize: info.size, sourceMtimeMs: Math.round(info.mtimeMs), updatedAt: new Date().toISOString() }));

  const result = await usage(directory);
  assert.equal(result.documents, 7);
  assert.equal(result.providers, 3);
  assert.equal(result.partial, false);
});

test('meta 与工作区不匹配时回退解析真实文件', async t => {
  const directory = await temporary(t);
  const store = await createStore(directory);
  await store.updateDocuments(documents => {
    documents.push({ ...documents[0], id: 'second', title: '第二篇', revision: 1, history: [] });
    return documents;
  });
  // 伪造一份过期 meta：大小对不上时必须忽略。
  const metaPath = join(directory, 'meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  await writeFile(metaPath, JSON.stringify({ ...meta, documents: 99, sourceSize: meta.sourceSize - 1 }));

  const result = await usage(directory);
  assert.equal(result.documents, 2);
  assert.equal(result.partial, false);
});

test('工作区损坏时隔离原文件并以空白工作区启动', async t => {
  const directory = await temporary(t);
  const original = '{ broken: ';
  await writeFile(join(directory, 'workspace.json'), original);

  const store = await createStore(directory);
  assert.ok(store.recovered, '应记录恢复信息');
  assert.match(store.recovered.backup, /workspace\.json\.corrupt-\d+$/);
  assert.equal(await readFile(store.recovered.backup, 'utf8'), original);
  assert.equal(store.state.documents.length, 1, '应以初始文档继续启动');
  assert.ok((await readdir(directory)).some(name => name.startsWith('workspace.json.corrupt-')), '原文件应保留在目录中');
  // 新工作区可以正常写入，不会再覆盖隔离文件。
  await store.updateDocuments(documents => documents);
  assert.equal(JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')).documents.length, 1);
});

test('结构不对（版本号错误）同样隔离', async t => {
  const directory = await temporary(t);
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 2, documents: [], providers: [] }));
  const store = await createStore(directory);
  assert.ok(store.recovered);
  assert.equal(store.state.documents.length, 1);
});
