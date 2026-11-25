import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfficeService } from '../lib/office.mjs';

async function seed(service, count, size = 4) {
  const base = Math.floor(Date.now() / 1000) - 200;
  for (let i = 0; i < count; i++) {
    const path = join(service.backups, `backup-${i}.bin`);
    await writeFile(path, Buffer.alloc(size, i));
    await utimes(path, base + i, base + i);
  }
}

test('备份按份数上限淘汰最旧文件，保留最新副本', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new OfficeService(directory, { backupMaxFiles: 3, backupMaxBytes: 1024 });
  await service.prepare();
  await seed(service, 6);

  const result = await service.pruneBackups();
  assert.deepEqual({ count: result.count, removed: result.removed }, { count: 3, removed: 3 });
  const left = (await readdir(service.backups)).sort();
  assert.deepEqual(left, ['backup-3.bin', 'backup-4.bin', 'backup-5.bin'], '应保留修改时间最新的三份');
});

test('备份按总体积上限淘汰，且不会把目录清空', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-retention-bytes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new OfficeService(directory, { backupMaxFiles: 10, backupMaxBytes: 8 });
  await service.prepare();
  await seed(service, 6);

  const result = await service.pruneBackups();
  assert.equal(result.bytes, 8, '保留两份 4 字节文件');
  assert.equal(result.count, 2);
  const left = (await readdir(service.backups)).sort();
  assert.deepEqual(left, ['backup-4.bin', 'backup-5.bin']);
});

test('单个备份就超过体积上限时，仍保留最新一份', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-retention-huge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new OfficeService(directory, { backupMaxFiles: 20, backupMaxBytes: 10 });
  await service.prepare();
  await seed(service, 3, 50);

  const result = await service.pruneBackups();
  assert.equal(result.count, 1, '必须保留刚生成的那份原件备份');
  assert.deepEqual(await readdir(service.backups), ['backup-2.bin']);
});

test('空备份目录与重复清理不报错', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-retention-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new OfficeService(directory);
  await service.prepare();
  assert.deepEqual(await service.pruneBackups(), { count: 0, bytes: 0, removed: 0 });
  await seed(service, 2);
  await service.pruneBackups();
  assert.deepEqual((await service.pruneBackups()).removed, 0);
});
