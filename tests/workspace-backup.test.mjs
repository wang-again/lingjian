import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createTestApp } from './fixtures/http.mjs';
import { createWorkspaceBackup, restoreWorkspaceBackup } from '../tools/workspace-backup.mjs';

test('完整工作区备份预览、校验和恢复后可重新打开，保留文件及文档', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingjian-workspace-backup-'));
  const source = join(root, 'source'), backup = join(root, 'backup'), target = join(root, 'restored');
  const app = await createTestApp({ dataDir: source });
  let restored;
  t.after(async () => {
    await app.close();
    await restored?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('lingjian-workspace-backup-'));
    await rm(root, { recursive: true, force: true });
  });
  const getBoot = app => fetch(`${app.url}/api/bootstrap`).then(response => response.json());
  const before = await getBoot(app);
  const file = await app.office.upload('备份验收.txt', Buffer.from('实际文件内容').toString('base64'));
  await writeFile(join(source, '.env'), 'NOT_A_REAL_KEY=never-copy');
  await assert.rejects(createWorkspaceBackup(source, backup), /锁定/);
  await app.close();

  assert.equal((await createWorkspaceBackup(source, backup)).officeFiles, 1);
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.every(file => !['.env', '.service.lock'].includes(file.path)));
  assert.equal((await restoreWorkspaceBackup(backup, target)).workspaces, 1);
  assert.ok(!(await readdir(root)).includes('restored'), '预览不创建目标');
  await restoreWorkspaceBackup(backup, target, { apply: true });
  await assert.rejects(restoreWorkspaceBackup(backup, target, { apply: true }), /目标目录已存在/);
  restored = await createTestApp({ dataDir: target });
  assert.deepEqual((await getBoot(restored)).documents, before.documents);
  assert.equal((await restored.office.listFiles())[0].name, file.name);
  assert.equal(await readFile(await restored.office.safePath(file.id), 'utf8'), '实际文件内容');

  await writeFile(join(backup, 'data', 'office', 'files', file.id), '损坏文件');
  await assert.rejects(restoreWorkspaceBackup(backup, join(root, 'bad'), { apply: true }), /校验失败/);
  assert.ok(!(await readdir(root)).includes('bad'));
});
