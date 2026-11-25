import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from './fixtures/http.mjs';

// 把 workspace.json 变成同名目录，可以让保存时的 rename 稳定抛非 UserError，
// 从而验证内部异常的日志与响应，而不用依赖具体平台错误码。
async function brokenWorkspace(directory) {
  await rm(join(directory, 'workspace.json'), { force: true });
  await mkdir(join(directory, 'workspace.json'), { recursive: true });
}

test('未处理异常会记录路径与堆栈，并在响应里给出可对照的错误编号', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-error-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await rm(join(directory, 'workspace.json'), { recursive: true, force: true }); await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const boot = await (await fetch(`${app.url}/api/bootstrap`)).json();
  await brokenWorkspace(directory);

  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(item => String(item)).join(' '));
  try {
    const response = await fetch(`${app.url}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': boot.token },
      body: JSON.stringify({ title: 't', html: '<p>x</p>', sources: [] })
    });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.match(payload.requestId, /^[a-f0-9]{8}$/, '响应必须带短编号');
    assert.equal(payload.error, '服务发生错误，请检查终端或重试。');
    assert.equal(lines.length, 1, '一次失败只应写一条日志');
    assert.ok(lines[0].includes(`[${payload.requestId}]`), '日志编号必须与响应一致');
    assert.ok(lines[0].includes('POST /api/documents'), '日志必须带请求方法与路径');
    assert.ok(lines[0].includes('Error'), '日志必须带异常堆栈');
  } finally { console.error = original; }
});

test('预期内的业务错误不写异常日志，保持终端干净', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-noise-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const boot = await (await fetch(`${app.url}/api/bootstrap`)).json();

  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(item => String(item)).join(' '));
  try {
    const response = await fetch(`${app.url}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': boot.token },
      body: JSON.stringify({ title: '缺正文', sources: [] })
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.requestId, undefined, '业务错误不应暴露内部编号');
    assert.equal(lines.length, 0);
  } finally { console.error = original; }
});
