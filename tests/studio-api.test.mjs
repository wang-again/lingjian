import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, listenHttp } from './fixtures/http.mjs';

const temporary = async () => mkdtemp(join(tmpdir(), 'lingjian-studio-'));
const MODEL_TEXT = '## 二、方案\n\n交付团队分三步推进。\n\n- 第一步\n- 第二步';

async function mockModel(t, requests, { delay = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    try { requests.push(JSON.parse(body)); } catch { requests.push({}); }
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: MODEL_TEXT } }] }));
  });
  await listenHttp(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

const HTML = '<h1>区域复盘</h1><h2>一、背景</h2><p>本季度收入 120 万元[资料：经营数据.md]。</p><h2>二、方案</h2><p></p><h2>三、预算</h2><p></p>';

test('章节工作台、任务队列、项目空间、批量审计与配方的接口闭环', async t => {
  const directory = await temporary();
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const requests = [];
  const baseUrl = await mockModel(t, requests);
  let bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const call = (path, method, body) => fetch(`${app.url}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': bootstrap.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (path, method, body) => { const response = await call(path, method, body); return { status: response.status, data: await response.json().catch(() => ({})) }; };

  const provider = await json('/api/providers', 'POST', { name: '验收模型', model: 'fixture', protocol: 'chat', baseUrl, apiKey: 'test' });
  assert.equal(provider.status, 200);

  let document = (await json('/api/documents', 'POST', { title: '区域复盘', html: HTML, sources: [] })).data.document;
  assert.equal(document.tasks.length, 0);
  assert.equal(document.locks && Object.keys(document.locks).length, 0);

  // 结构读取
  let sections = await json(`/api/documents/${document.id}/sections`);
  assert.equal(sections.status, 200);
  assert.deepEqual(sections.data.sections.map(item => item.title), ['一、背景', '二、方案', '三、预算']);
  const planKey = sections.data.sections[1].key;
  const budgetKey = sections.data.sections[2].key;

  // 章节调整：插入、移动、锁定的失效清理
  const inserted = await json(`/api/documents/${document.id}/outline`, 'POST', { revision: document.revision, op: 'insert', title: '四、附录' });
  assert.equal(inserted.status, 200);
  assert.equal(inserted.data.sections.length, 4);
  document = inserted.data.document;
  const moved = await json(`/api/documents/${document.id}/outline`, 'POST', { revision: document.revision, op: 'move', key: budgetKey, delta: 1 });
  assert.equal(moved.status, 200);
  assert.ok(moved.data.sections.findIndex(item => item.title === '三、预算') > moved.data.sections.findIndex(item => item.title === '二、方案'));
  assert.equal((await json(`/api/documents/${document.id}/outline`, 'POST', { revision: document.revision - 1, op: 'move', key: budgetKey, delta: 1 })).status, 409);
  document = moved.data.document;

  const locked = await json(`/api/documents/${document.id}/locks`, 'PUT', { locks: { [planKey]: true, [budgetKey]: false } });
  assert.equal(locked.status, 200);
  assert.deepEqual(locked.data.locks, { [planKey]: true });

  // 锁定章节不执行，任务留在队列里
  const lockedTask = (await json(`/api/documents/${document.id}/tasks`, 'POST', { tasks: [{ kind: 'chapter', title: '补全方案', chapterKey: planKey, chapterTitle: '二、方案', instruction: '分三步' }] })).data.tasks[0];
  const lockedRun = await json(`/api/documents/${document.id}/tasks/run`, 'POST', { revision: document.revision, providerId: provider.data.provider.id, taskId: lockedTask.id });
  assert.equal(lockedRun.status, 409);
  bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.equal(bootstrap.documents.find(item => item.id === document.id).tasks[0].status, 'queued');

  // 解锁后执行：只改该章，其余章节逐字节不变
  await json(`/api/documents/${document.id}/locks`, 'PUT', { locks: {} });
  const run = await json(`/api/documents/${document.id}/tasks/run`, 'POST', { revision: document.revision, providerId: provider.data.provider.id, taskId: lockedTask.id });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const beforeRunRevision = document.revision;
  document = run.data.document;
  assert.equal(run.data.task.status, 'done');
  assert.ok(document.html.includes('<h2>二、方案</h2><p>交付团队分三步推进。</p>'));
  assert.ok(document.html.includes('本季度收入 120 万元'));
  assert.equal((document.html.match(/二、方案/g) || []).length, 1);
  assert.equal(document.revision, beforeRunRevision + 1);
  // 交到模型的上下文只有本章，且明确只写本章
  const firstPrompt = JSON.stringify(requests[0]);
  assert.ok(firstPrompt.includes('只写《二、方案》这一章'));
  assert.ok(!firstPrompt.includes('本季度收入 120 万元'));
  assert.ok(!firstPrompt.includes('三、预算'));

  // 体检任务不需要模型
  const checkTask = (await json(`/api/documents/${document.id}/tasks`, 'POST', { tasks: [{ kind: 'check', title: '交付体检' }, { kind: 'evidence', title: '核依据' }] })).data.tasks.find(item => item.status === 'queued' && item.kind === 'check');
  const checked = await json(`/api/documents/${document.id}/tasks/run`, 'POST', { revision: document.revision, taskId: checkTask.id });
  assert.equal(checked.status, 200, JSON.stringify(checked.data));
  assert.ok(checked.data.document.delivery.grade);
  assert.equal(checked.data.document.delivery.forRevision, checked.data.document.revision);
  document = checked.data.document;

  // 跳过与删除任务
  const evidenceTask = document.tasks.find(item => item.kind === 'evidence' && item.status === 'queued');
  const skipped = await json(`/api/documents/${document.id}/tasks/${evidenceTask.id}`, 'PATCH', { status: 'skipped' });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.data.tasks.find(item => item.id === evidenceTask.id).status, 'skipped');
  const removed = await json(`/api/documents/${document.id}/tasks/${evidenceTask.id}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.ok(!removed.data.tasks.some(item => item.id === evidenceTask.id));
  const refreshed = (await json(`/api/documents/${document.id}/sections`)).data;
  assert.equal(refreshed.tasks.every(item => item.status !== 'running'), true);
  // 取最新的文档版本，后续依据核验要求 revision 与落盘一致。
  bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  document = bootstrap.documents.find(item => item.id === document.id);

  // 项目知识空间：资料入库、检索、绑定文档后引用可被核到
  const project = await json('/api/projects', 'POST', { name: '华东区复盘项目', description: '区域资料' });
  assert.equal(project.status, 201);
  assert.equal((await json('/api/projects', 'POST', { name: '华东区复盘项目' })).status, 409);
  const projectId = project.data.project.id;
  const added = await json(`/api/projects/${projectId}/sources`, 'POST', { sources: [{ name: '经营数据.md', text: '本季度收入 120 万元，同比增长 18%。' }] });
  assert.equal(added.status, 201);
  assert.equal(added.data.project.sources.length, 1);
  const searched = await json(`/api/projects/${projectId}/search`, 'POST', { query: '本季度收入' });
  assert.equal(searched.status, 200);
  assert.equal(searched.data.matches.length, 1);
  assert.ok(searched.data.matches[0].snippet.includes('120 万元'));

  const before = await json(`/api/documents/${document.id}/evidence`, 'POST', { revision: document.revision });
  assert.equal(before.data.evidence.claims.find(claim => claim.plain.includes('120 万元')).status, 'broken');
  const bound = await json(`/api/documents/${document.id}/project`, 'POST', { projectId });
  assert.equal(bound.status, 200);
  assert.equal(bound.data.document.projectId, projectId);
  const after = await json(`/api/documents/${document.id}/evidence`, 'POST', { revision: bound.data.document.revision });
  assert.equal(after.data.evidence.claims.find(claim => claim.plain.includes('120 万元')).status, 'supported');
  assert.equal(after.data.evidence.claims.find(claim => claim.plain.includes('120 万元')).source.name, '经营数据.md');

  // 批量审计：单篇也能给出等级与对比表
  const batch = await json('/api/batch-audit', 'POST', { ids: [document.id] });
  assert.equal(batch.status, 200);
  assert.equal(batch.data.report.count, 1);
  assert.ok(batch.data.report.rows[0].sources.total >= 1);
  assert.equal(batch.data.report.compare.rows.length, 1);
  bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.equal(bootstrap.projects.length, 1);
  assert.ok(bootstrap.recipes.some(item => item.id === 'builtin-fill-empty'));
  assert.equal(bootstrap.lastAudit.count, 1);

  // 配方：由队列存配方、应用到文档、删除
  const saved = await json('/api/recipes', 'POST', { fromDocumentId: document.id, name: '我的复盘套路' });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const recipeId = saved.data.recipe.id;
  assert.ok(saved.data.recipe.steps.length >= 1);
  assert.equal((await json('/api/recipes', 'POST', { recipe: { name: '我的复盘套路', steps: [{ kind: 'check' }] } })).status, 409);
  const applied = await json(`/api/recipes/${recipeId}/apply`, 'POST', { documentId: document.id });
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.ok(applied.data.added >= 1);
  assert.equal((await json(`/api/recipes/${recipeId}/apply`, 'POST', { documentId: 'missing' })).status, 404);
  const deleted = await json(`/api/recipes/${recipeId}`, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.ok(!deleted.data.recipes.some(item => item.id === recipeId));
  assert.ok(deleted.data.recipes.some(item => item.id === 'builtin-fill-empty'));
});

test('任务队列在文档被外部更新时拒绝写入，并把任务退回队列', async t => {
  const directory = await temporary();
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const requests = [];
  const baseUrl = await mockModel(t, requests, { delay: 150 });
  const bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const call = (path, method, body) => fetch(`${app.url}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': bootstrap.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (path, method, body) => { const response = await call(path, method, body); return { status: response.status, data: await response.json().catch(() => ({})) }; };

  const providerId = (await json('/api/providers', 'POST', { name: '验收模型', model: 'fixture', protocol: 'chat', baseUrl, apiKey: 'test' })).data.provider.id;
  const document = (await json('/api/documents', 'POST', { title: '并发检查', html: '<h2>一、背景</h2><p>已有。</p><h2>二、方案</h2><p></p>', sources: [] })).data.document;
  const key = (await json(`/api/documents/${document.id}/sections`)).data.sections[1].key;
  const task = (await json(`/api/documents/${document.id}/tasks`, 'POST', { tasks: [{ kind: 'chapter', title: '补全方案', chapterKey: key }] })).data.tasks[0];

  // 执行前先用另一个请求改掉正文，模拟“模型生成期间用户继续编辑”。
  const racing = (async () => json(`/api/documents/${document.id}/tasks/run`, 'POST', { revision: document.revision, providerId, taskId: task.id }))();
  await new Promise(resolve => setTimeout(resolve, 40));
  const edit = await json(`/api/documents/${document.id}`, 'PUT', { title: '并发检查', html: '<h2>一、背景</h2><p>用户改过的正文。</p><h2>二、方案</h2><p></p>', sources: [], revision: document.revision });
  assert.equal(edit.status, 200);
  const result = await racing;
  assert.equal(result.status, 409);
  const after = await json(`/api/documents/${document.id}/sections`);
  assert.equal(after.data.tasks[0].status, 'queued');
  // 消息内容取决于两个请求的先后：无论谁先到，任务都必须回到队列而不是卡在 running。
});
