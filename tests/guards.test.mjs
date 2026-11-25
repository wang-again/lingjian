import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDataLock } from '../lib/data-lock.mjs';
import { assertJsonBudget } from '../lib/json-guard.mjs';
import { UserError } from '../lib/providers.mjs';

const temporary = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
};

test('数据锁：占用中拒绝第二个实例，释放后可重新获取', async t => {
  const directory = await temporary(t);
  const release = await acquireDataLock(directory);
  await assert.rejects(acquireDataLock(directory), /锁定/);
  await release();
  const again = await acquireDataLock(directory);
  await again();
});

test('数据锁：持有进程已退出时自动接管', async t => {
  const directory = await temporary(t);
  await writeFile(join(directory, '.service.lock'), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
  const release = await acquireDataLock(directory);
  const lock = JSON.parse(await readFile(join(directory, '.service.lock'), 'utf8'));
  assert.equal(lock.pid, process.pid);
  await release();
});

test('数据锁：持有进程仍在运行时保持锁定', async t => {
  const directory = await temporary(t);
  await writeFile(join(directory, '.service.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await assert.rejects(acquireDataLock(directory), /锁定/);
});

test('数据锁：写入中断的空锁文件过宽限期后接管，未过期则继续等待', async t => {
  const directory = await temporary(t);
  const file = join(directory, '.service.lock');
  await writeFile(file, '');
  await assert.rejects(acquireDataLock(directory), /锁定/, '刚写入的锁可能仍在写 pid，不能抢');
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
  const release = await acquireDataLock(directory);
  await release();
});

test('JSON 预算：超过层级上限被拒绝', () => {
  let value = { leaf: true };
  for (let i = 0; i < 9; i++) value = { nested: value };
  assert.throws(() => assertJsonBudget(value, { label: 'spec_json' }), error => error instanceof UserError && /嵌套层级/.test(error.message));
  const allowed = { a: { b: { c: 1 } } };
  assert.equal(assertJsonBudget(allowed), allowed);
});

test('JSON 预算：十万层嵌套不会导致栈溢出', () => {
  const root = {};
  let cursor = root;
  for (let i = 0; i < 100_000; i++) { cursor.next = {}; cursor = cursor.next; }
  assert.throws(() => assertJsonBudget(root, { label: 'modifications_json' }), error => error instanceof UserError && /嵌套层级/.test(error.message));
});

test('JSON 预算：节点数超过上限被拒绝', () => {
  const list = Array.from({ length: 20_001 }, (_, i) => i);
  assert.throws(() => assertJsonBudget(list, { label: 'sheets_json' }), error => error instanceof UserError && /字段数量/.test(error.message));
});

test('JSON 预算：正常参数原样通过', () => {
  const value = { slides: [{ id: 's1', blocks: [{ text: '内容' }] }] };
  assert.equal(assertJsonBudget(value), value);
});
