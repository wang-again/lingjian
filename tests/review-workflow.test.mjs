import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { findAnnotationOffset } from '../public/annotations.js';
import { createTestApp } from './fixtures/http.mjs';

test('体检复检区分剩余、新增和已消失的问题，并保留同一版的确认状态', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-review-workflow-'));
  let app = await createTestApp({ dataDir: directory });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^lingjian-review-workflow-/);
    await rm(directory, { recursive: true, force: true });
  });
  const bootstrap = () => fetch(`${app.url}/api/bootstrap`).then(response => response.json());
  let { token, documents: [doc] } = await bootstrap();
  const path = `/api/documents/${doc.id}`;
  const send = (route, method, body) => fetch(`${app.url}${path}${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token }, body: JSON.stringify(body)
  });
  const update = async html => {
    const result = await send('', 'PUT', { ...doc, html });
    assert.equal(result.status, 200);
    doc = (await result.json()).document;
  };
  const check = async () => {
    const response = await send('/delivery-check', 'POST', { revision: doc.revision });
    assert.equal(response.status, 200);
    return (await response.json()).report;
  };
  const confirm = async (report, issue, confirmed = true) =>
    send(`/delivery-issues/${issue.id}`, 'PATCH', { at: report.at, confirmed });
  await update('<h2>会议任务</h2><p>项目组需要核对会议纪要中记录的行动事项和责任人，标记待补充内容并安排后续沟通。</p><h2>空章节</h2>');
  const initial = await check();
  const brief = initial.issues.find(issue => issue.category === 'brief');
  const changed = await confirm(initial, brief);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).report.issues.find(issue => issue.id === brief.id).confirmed, true);
  await app.close();
  app = await createTestApp({ dataDir: directory });
  ({ token, documents: [doc] } = await bootstrap());
  assert.equal(doc.delivery.issues.find(issue => issue.id === brief.id).confirmed, true);
  assert.equal((await check()).issues.find(issue => issue.id === brief.id).confirmed, true);

  await update('<h2>会议任务</h2><p>后续由记录员核对全部行动事项，核对完成后将会议纪要和参考文件一并归档。[资料：不存在]</p><h2>空章节</h2>');
  assert.equal((await confirm(initial, brief, false)).status, 409);
  const report = await check();
  assert.ok(report.cleared.some(title => title.includes('未补齐内容')));
  assert.ok(report.issues.some(issue => issue.category === 'structure' && issue.change === 'remaining'));
  assert.ok(report.issues.some(issue => issue.category === 'citation' && issue.change === 'new'));
  assert.equal(report.issues.find(issue => issue.category === 'brief').confirmed, false);
  assert.equal((await confirm(report, report.issues.find(issue => issue.category === 'brief'))).status, 200);
  assert.ok((await check()).cleared.includes(report.cleared[0]));
});

test('批注随文档保存，正文版本变更后可重新定位或手动绑定选区', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-annotations-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^lingjian-annotations-/);
    await rm(directory, { recursive: true, force: true });
  });
  const bootstrap = () => fetch(`${app.url}/api/bootstrap`).then(response => response.json());
  const { token, documents: [doc] } = await bootstrap();
  const send = (route, method, body) => fetch(`${app.url}/api/documents/${doc.id}${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token }, body: JSON.stringify(body)
  });
  const saved = await send('', 'PUT', { ...doc, html: '<p>请核对金额。</p><p>本周安排</p>' });
  assert.equal(saved.status, 200);
  const initial = (await saved.json()).document;
  const anchor = { quote: '核对金额', prefix: '请', suffix: '。' };
  const input = { id: 'annotation-1', note: '等财务回复', anchor, revision: initial.revision };
  const added = await send('/annotations', 'POST', input);
  assert.equal(added.status, 200);
  assert.deepEqual((await added.json()).annotations, [{ id: input.id, note: input.note, anchor, resolved: false }]);
  const retried = await send('/annotations', 'POST', input);
  assert.equal((await retried.json()).annotations.length, 1);
  const updated = await send('', 'PUT', { ...initial, html: '<p>本周安排</p><p>请核对金额。</p>' });
  assert.equal(updated.status, 200);
  const moved = (await updated.json()).document;
  assert.equal(moved.annotations.length, 1);
  assert.equal(findAnnotationOffset('本周安排请核对金额。', anchor), 5);
  assert.equal(findAnnotationOffset('请核对金额。请核对金额。', anchor), -1);
  assert.equal(findAnnotationOffset('将核对金额！请核对金额。', anchor), 7);
  assert.equal(findAnnotationOffset('本周安排，已完成核对。', anchor), -1);
  assert.equal((await send('/annotations/annotation-1', 'PATCH', { revision: initial.revision, resolved: true })).status, 409);
  const reanchor = { quote: '本周安排', prefix: '', suffix: '请核对金额。' };
  assert.equal((await send('/annotations/annotation-1', 'PATCH', { revision: moved.revision, anchor: reanchor })).status, 200);
  assert.equal((await send('/annotations/annotation-1', 'PATCH', { revision: moved.revision, resolved: true })).status, 200);
  const persisted = (await bootstrap()).documents[0];
  assert.deepEqual(persisted.annotations[0], { id: input.id, note: input.note, anchor: reanchor, resolved: true });
  assert.equal(persisted.revision, moved.revision);
  assert.equal((await send('/annotations/annotation-1', 'PATCH', { revision: moved.revision, resolved: false })).status, 200);
});
