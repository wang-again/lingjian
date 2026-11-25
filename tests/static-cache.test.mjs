import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from './fixtures/http.mjs';

test('静态资源带 ETag，未改动时返回 304 并复用缓存', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-static-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });

  const first = await fetch(`${app.url}/app.js`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, '静态资源必须带 ETag');
  assert.equal(first.headers.get('cache-control'), 'no-cache', '允许缓存但每次协商');
  const body = await first.text();
  assert.ok(body.length > 1000);

  const second = await fetch(`${app.url}/app.js`, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304, 'ETag 未变化时返回 304');
  assert.equal((await second.text()).length, 0, '304 不应重传正文');

  const changed = await fetch(`${app.url}/app.js`, { headers: { 'If-None-Match': '"stale-hash"' } });
  assert.equal(changed.status, 200, 'ETag 不匹配时必须重新返回内容');
  await changed.text();
});

test('接口响应仍然是 no-store，避免缓存文档内容', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-api-cache-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });

  const status = await fetch(`${app.url}/api/auth/status`);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  const boot = await fetch(`${app.url}/api/bootstrap`);
  assert.equal(boot.headers.get('cache-control'), 'no-store');
  await status.text(); await boot.text();
});

test('静态资源映射来自目录扫描：所有前端文件可直接访问，未知路径与穿越路径 404', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-static-index-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const { readdir } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const publicRoot = joinPath(process.cwd(), 'public');
  const files = (await readdir(publicRoot, { withFileTypes: true })).filter(entry => entry.isFile() && /\.(js|css|html|svg)$/.test(entry.name));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const path = file.name === 'index.html' ? '/' : `/${file.name}`;
    const response = await fetch(`${app.url}${path}`);
    assert.equal(response.status, 200, `${path} 应可访问`);
    await response.arrayBuffer();
  }
  assert.equal((await fetch(`${app.url}/missing-page.js`)).status, 404);
  assert.equal((await fetch(`${app.url}/../server.mjs`)).status, 404);
});

test('createAssetIndex 只收录已知类型，跳过子目录与隐藏文件', async t => {
  const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
  const { createAssetIndex } = await import('../lib/static-assets.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<!doctype html>');
  await writeFile(join(directory, 'app.js'), 'export {};');
  await writeFile(join(directory, '.env'), 'SECRET=1');
  await writeFile(join(directory, 'notes.exe'), 'binary');
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'nested', 'inner.js'), 'export {};');
  const assets = await createAssetIndex(directory);
  assert.equal(assets.get('/'), 'index.html');
  assert.equal(assets.get('/app.js'), 'app.js');
  assert.equal(assets.get('/.env'), undefined);
  assert.equal(assets.get('/notes.exe'), undefined);
  assert.equal(assets.get('/nested/inner.js'), undefined);
});
