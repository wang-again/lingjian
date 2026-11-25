import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, rename, mkdir, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createTestApp } from './fixtures/http.mjs';
import { backupLimit, createBackupManager } from '../lib/backups.mjs';
import { createStore } from '../lib/store.mjs';
import { backupVolumes } from '../public/backup-ui.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-backups-'));
  let app = await createTestApp({ dataDir: directory, ...options });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('lingjian-backups-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { directory, get app() { return app; }, async restart() { await app.close(); app = await createTestApp({ dataDir: directory, ...options }); } };
}
async function client(f, username) {
  let cookie = '';
  if (username) {
    const res = await fetch(`${f.app.url}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'backup-test-password-123456' }) });
    assert.equal(res.status, 200); cookie = res.headers.get('set-cookie').split(';')[0];
  }
  const boot = await (await fetch(`${f.app.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  const call = (path, body, method = 'POST', headers = {}) => fetch(`${f.app.url}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workspace-Token': boot.token, ...headers }, body: JSON.stringify(body) });
  return { boot, call, cookie };
}
const wrap = documents => ({ product: 'lingjian', version: 1, documents });

test('超过 50 MB 的单篇文档保存全部历史，和其他文档分卷后均可恢复', async t => {
  const f = await fixture(t), c = await client(f), original = c.boot.documents[0];
  const html = `<p>${'文'.repeat(850_000)}</p>`;
  const history = Array.from({ length: 20 }, (_, i) => ({ id: `history-${i}`, title: '历史版本', html, at: original.createdAt, label: '回归验证' }));
  const volumes = backupVolumes([{ ...original, id: 'large-doc', html, history }, { ...original, id: 'small-doc' }]);
  assert.equal(volumes.length, 2);
  assert.ok(volumes[0].size > 50_000_000);
  assert.ok(volumes[0].size < backupLimit);
  const [first, second] = await Promise.all(volumes.map(async volume => JSON.parse(await volume.text())));
  assert.equal(first.documents[0].id, 'large-doc');
  assert.deepEqual(first.documents[0].history, history);
  assert.equal(second.documents[0].id, 'small-doc');
  for (const backup of [first, second]) {
    const response = await c.call('/api/backups/preview', { backup, mode: 'copy' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.documents.map(({ id, history }) => ({ id, history })), backup.documents.map(doc => ({ id: doc.id, history: doc.history.length })));
    const applied = await c.call('/api/backups/apply', { planId: result.planId });
    assert.equal(applied.status, 200);
    const saved = (await applied.json()).documents.find(doc => doc.id === backup.documents[0].id);
    assert.equal(saved.html, backup.documents[0].html);
    assert.deepEqual(saved.history, backup.documents[0].history);
  }
});

test('清空目标工作区后可恢复满额的 200 篇文档', async t => {
  const f = await fixture(t), c = await client(f), original = c.boot.documents[0];
  const deleted = await c.call(`/api/documents/${original.id}`, { revision: original.revision }, 'DELETE');
  assert.equal(deleted.status, 200);
  const backup = wrap(Array.from({ length: 200 }, (_, i) => ({ ...original, id: `full-backup-${i}` })));
  const preview = await c.call('/api/backups/preview', { backup, mode: 'copy' });
  assert.equal(preview.status, 200);
  const { planId } = await preview.json();
  const applied = await c.call('/api/backups/apply', { planId });
  assert.equal(applied.status, 200);
  const { documents, snapshotId } = await applied.json();
  assert.equal(snapshotId, undefined);
  assert.deepEqual(new Set(documents.map(doc => doc.id)), new Set(backup.documents.map(doc => doc.id)));
});

test('备份预览无写入，副本/跳过/替换保留资料历史，快照可恢复且重启持久化', async t => {
  const f = await fixture(t), c = await client(f), original = c.boot.documents[0];
  const imported = { ...original, html: '<h2>恢复正文</h2>', sources: [{ id: 'ref', name: '材料.txt', text: '恢复资料', enabled: false }], history: [{ id: 'h1', title: '原历史', html: '<p>历史正文</p>', label: '人工保存', at: original.createdAt }], apiKey: 'untrusted-secret', _dirty: true };
  const before = await readFile(join(f.directory, 'workspace.json'), 'utf8');
  let preview = await (await c.call('/api/backups/preview', { backup: wrap([imported]), mode: 'copy' })).json();
  assert.equal(preview.added, 1); assert.equal(preview.replaced, 0);
  assert.equal(await readFile(join(f.directory, 'workspace.json'), 'utf8'), before);
  const [one, two] = await Promise.all([c.call('/api/backups/apply', { planId: preview.planId }), c.call('/api/backups/apply', { planId: preview.planId })]);
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  const copy = await one.json(); assert.equal(copy.documents.length, 2);
  const added = copy.documents.find(d => d.id !== original.id);
  assert.match(added.title, /恢复副本/); assert.deepEqual(added.sources, imported.sources); assert.deepEqual(added.history, [{ ...imported.history[0], at: new Date(imported.history[0].at).toISOString() }]);
  assert.ok(!JSON.stringify(copy).includes('untrusted-secret'));
  const point = JSON.parse(await readFile(join(f.directory, 'restore-points', `${copy.snapshotId}.json`), 'utf8'));
  assert.deepEqual(point.documents, c.boot.documents);
  const download = await fetch(`${f.app.url}/api/backups/snapshots/${copy.snapshotId}`);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(await download.json(), point);
  const recoveryPreview = await c.call('/api/backups/preview', { backup: point, mode: 'replace' }); assert.equal(recoveryPreview.status, 200);
  preview = await (await c.call('/api/backups/preview', { backup: wrap([imported]), mode: 'skip' })).json();
  assert.equal(preview.skipped, 1);
  assert.equal((await (await c.call('/api/backups/apply', { planId: preview.planId })).json()).documents.length, 2);
  preview = await (await c.call('/api/backups/preview', { backup: wrap([imported]), mode: 'replace' })).json();
  const replaced = await (await c.call('/api/backups/apply', { planId: preview.planId })).json();
  const restored = replaced.documents.find(d => d.id === original.id);
  assert.equal(restored.html, imported.html); assert.equal(restored.revision, original.revision + 1);
  assert.equal(restored.history[0].label, '备份恢复前'); assert.equal(restored.history[0].html, original.html);
  assert.deepEqual(restored.sources, imported.sources);
  await f.restart(); const restarted = await client(f);
  assert.deepEqual(restarted.boot.documents, replaced.documents);
});

test('损坏备份、重复ID、越界资料和无效历史整批拒绝；过期/他会话预览不可应用', async t => {
  const f = await fixture(t, { authMode: 'accounts' }), a = await client(f, 'alice'), b = await client(f, 'bob');
  const original = a.boot.documents[0];
  for (const backup of [null, { product: 'other', version: 1, documents: [original] }, { ...wrap([original]), version: 2 }, wrap([original, original]), wrap([{ ...original, html: 12 }]), wrap([{ ...original, sources: [{ id: 'a', name: 'x', text: 'x'.repeat(300001) }] }]), wrap([{ ...original, history: [{ id: 'bad', title: 'x', html: 'x', label: 'x', at: 'bad' }] }])]) {
    assert.equal((await a.call('/api/backups/preview', { backup, mode: 'copy' })).status, 400);
  }
  assert.equal((await a.call('/api/backups/preview', { backup: wrap([original]), mode: 'unknown' })).status, 400);
  const p = await (await a.call('/api/backups/preview', { backup: wrap([original]), mode: 'copy' })).json();
  assert.equal((await b.call('/api/backups/apply', { planId: p.planId })).status, 409);
  const imported = await (await a.call('/api/backups/apply', { planId: p.planId })).json();
  assert.equal((await b.call(`/api/backups/snapshots/${imported.snapshotId}`, undefined, 'GET')).status, 404);
  assert.equal((await fetch(`${f.app.url}/api/backups/snapshots/${imported.snapshotId}`)).status, 401);
  assert.equal((await a.call('/api/backups/apply', { planId: p.planId }, 'POST', { 'X-Workspace-Token': 'bad' })).status, 403);
  assert.equal((await fetch(`${f.app.url}/api/backups/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: p.planId }) })).status, 401);
  assert.equal((await a.call('/api/backups/apply', { planId: 'expired' })).status, 409);
  const disk = JSON.parse(await readFile(join(f.directory, 'users', a.boot.user.id, 'workspace.json'), 'utf8'));
  const withoutHistory = documents => documents.map(({ history, ...document }) => document);
  assert.deepEqual(withoutHistory(disk.documents), withoutHistory(imported.documents), '主文件保存当前正文，历史单独存放');
  for (const document of imported.documents.filter(item => item.history.length)) {
    const history = JSON.parse(await readFile(join(f.directory, 'users', a.boot.user.id, 'history', `${document.id}.json`), 'utf8'));
    assert.deepEqual(history, document.history, '历史快照应落在 history/<文档ID>.json');
  }
});

test('预览后编辑或并发保存不覆盖新内容，超过文档上限拒绝', async t => {
  const f = await fixture(t), c = await client(f), original = c.boot.documents[0];
  const p = await (await c.call('/api/backups/preview', { backup: wrap([original]), mode: 'replace' })).json();
  const responses = await Promise.all([c.call(`/api/documents/${original.id}`, { ...original, html: '<p>新修改</p>' }, 'PUT'), c.call(`/api/documents/${original.id}`, { ...original, html: '<p>过期修改</p>' }, 'PUT')]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal((await c.call('/api/backups/apply', { planId: p.planId })).status, 409);
  const many = Array.from({ length: 200 }, (_, i) => ({ ...original, id: `restore-${i}` }));
  assert.equal((await c.call('/api/backups/preview', { backup: wrap(many), mode: 'copy' })).status, 400);
  assert.equal((await readdir(f.directory)).includes('restore-points'), false);
});

test('磁盘替换失败不提交内存，恢复磁盘后可重试且清理临时文件', async t => {
  const f = await fixture(t), c = await client(f), doc = c.boot.documents[0];
  const file = join(f.directory, 'workspace.json'), held = join(f.directory, 'workspace-held.json');
  await rename(file, held); await mkdir(file);
  assert.equal((await c.call(`/api/documents/${doc.id}`, { ...doc, html: '<p>待恢复</p>' }, 'PUT')).status, 500);
  assert.deepEqual(f.app.store.state.documents, c.boot.documents);
  assert.ok(!(await readdir(f.directory)).some(name => name.endsWith('.tmp')));
  await rmdir(file); await rename(held, file);
  assert.equal((await c.call(`/api/documents/${doc.id}`, { ...doc, html: '<p>待恢复</p>' }, 'PUT')).status, 200);
});

test('预览真正过期后拒绝应用', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-backups-'));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('lingjian-backups-')); await rm(directory, { recursive: true, force: true }); });
  const store = await createStore(directory); let time = 1000;
  const manager = createBackupManager(store, input => ({ ...input, history: [], revision: 1 }), { now: () => time });
  const plan = await manager.preview(wrap(store.state.documents), 'copy', 'owner'); time += 16 * 60_000;
  await assert.rejects(manager.apply(plan.planId, 'owner'), /失效/);
});

test('在独立工作区真实恢复，ID、正文、资料和历史一致，模型配置不导入', async t => {
  const source = await fixture(t), a = await client(source), doc = a.boot.documents[0];
  const saved = await (await a.call(`/api/documents/${doc.id}`, { ...doc, title: '跨工作区恢复', html: '<p>新正文</p>', snapshot: '编辑前', sources: [{ id: 'ref', name: '材料', text: '资料内容', enabled: false }] }, 'PUT')).json();
  const target = await fixture(t), b = await client(target);
  const preview = await (await b.call('/api/backups/preview', { backup: { ...wrap([saved.document]), providers: [{ apiKey: 'must-not-import' }] }, mode: 'copy' })).json();
  const result = await (await b.call('/api/backups/apply', { planId: preview.planId })).json();
  const restored = result.documents.find(d => d.id === doc.id);
  for (const field of ['id', 'title', 'html', 'sources', 'history', 'createdAt', 'updatedAt']) assert.deepEqual(restored[field], saved.document[field]);
  assert.equal(result.documents.length, 2);
  assert.ok(!(await readFile(join(target.directory, 'workspace.json'), 'utf8')).includes('must-not-import'));
});

test('导入落盘失败保留全部旧文档和恢复快照，修复后重试同一预览成功', async t => {
  const f = await fixture(t), c = await client(f), original = c.boot.documents[0];
  const p = await (await c.call('/api/backups/preview', { backup: wrap([{ ...original, html: '<p>恢复内容</p>' }]), mode: 'replace' })).json();
  const file = join(f.directory, 'workspace.json'), held = join(f.directory, 'workspace-held.json');
  await rename(file, held); await mkdir(file);
  assert.equal((await c.call('/api/backups/apply', { planId: p.planId })).status, 500);
  assert.deepEqual(f.app.store.state.documents, c.boot.documents);
  const snapshots = await readdir(join(f.directory, 'restore-points'));
  assert.equal(snapshots.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'restore-points', snapshots[0]), 'utf8')).documents, c.boot.documents);
  await rmdir(file); await rename(held, file);
  const retry = await c.call('/api/backups/apply', { planId: p.planId }); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).documents[0].html, '<p>恢复内容</p>');
});

test('预览内容暂存在磁盘计划文件，应用后删除，避免整份文档常驻内存', async t => {
  const f = await fixture(t), c = await client(f), original = c.boot.documents[0];
  const huge = { ...original, id: 'disk-plan', html: `<p>${'文'.repeat(600_000)}</p>`, history: [] };
  const preview = await (await c.call('/api/backups/preview', { backup: wrap([huge]), mode: 'copy' })).json();
  const file = join(f.directory, 'imports', `${preview.planId}.json`);
  const info = await stat(file);
  assert.ok(info.size > 1_000_000, `计划文件应保存完整正文，实际 ${info.size} 字节`);
  const applied = await c.call('/api/backups/apply', { planId: preview.planId });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).documents.find(doc => doc.id === 'disk-plan').html, huge.html);
  await assert.rejects(stat(file), /ENOENT/);
});
