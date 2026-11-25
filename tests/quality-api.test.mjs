import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from './fixtures/http.mjs';

const temporary = async () => mkdtemp(join(tmpdir(), 'lingjian-quality-'));

test('简报、依据台账、交付体检与自定义模板的完整接口闭环', async t => {
  const directory = await temporary();
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  let bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const call = (path, method, body) => fetch(`${app.url}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': bootstrap.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const sample = await call('/api/documents', 'POST', {
    title: '华东区复盘', html: '<h2>一、项目概述</h2><p>本项目服务制造业客户。</p><h2>二、实施计划</h2><table><tr><th>阶段</th><th>负责人</th><th>时间</th></tr><tr><td>一期</td><td>张三</td><td>3 月</td></tr></table><h2>三、风险与应对</h2><p>需求变更需要每周确认。</p>', sources: [],
    brief: { purpose: '区域复盘', audience: '管理层', scope: '华东区', keyPoints: ['一期由张三负责'], terminology: [{ term: 'ARPU', definition: '单用户收入' }], constraints: '不超过 3 页', sourcePolicy: '只使用内部资料' }
  });
  assert.equal(sample.status, 201);
  const first = (await sample.json()).document;
  assert.equal(first.brief.purpose, '区域复盘');
  assert.ok(first.brief.updatedAt);

  assert.equal((await call('/api/documents', 'POST', { title: 'x', html: '', sources: [], brief: { purpose: 1 } })).status, 400);

  const second = (await (await call('/api/documents', 'POST', { title: '华南区复盘', html: '<h2>一、项目概述</h2><p>另一个项目。</p><h2>二、实施计划</h2><p>分两期推进。</p><h2>三、风险与应对</h2><p>预算不确定。</p>', sources: [] })).json()).document;

  const distilled = await call('/api/templates/distill', 'POST', { documentIds: [first.id, second.id], title: '区域复盘模板' });
  assert.equal(distilled.status, 200);
  const draft = (await distilled.json()).template;
  assert.deepEqual(draft.sections, ['项目概述', '实施计划', '风险与应对']);
  assert.ok(draft.content.includes('| 阶段 | 负责人 | 时间 |'));

  const saved = await call('/api/templates', 'POST', { template: draft });
  assert.equal(saved.status, 201);
  const custom = (await saved.json()).template;
  assert.match(custom.id, /^custom-/);
  assert.equal((await call('/api/templates', 'POST', { template: draft })).status, 409);
  bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.ok(bootstrap.templates.some(item => item.id === custom.id));
  const markdown = await fetch(`${app.url}/api/templates/${custom.id}/assets/markdown`);
  assert.equal(markdown.status, 200);
  assert.match(await markdown.text(), /区域复盘模板/);

  const withTemplate = await call(`/api/documents/${first.id}`, 'PUT', { ...first, templateId: custom.id, html: '<h2>一、预算</h2><p>预算待补充。</p><p>本季度收入 120 万元[资料：经营数据.md]。</p><h2>二、依据</h2><p>需求增长 20%[资料：不存在的报告.pdf]。</p>', sources: [{ id: 's1', name: '经营数据.md', text: '本季度收入 120 万元，同比增长 18%。', enabled: true }] });
  assert.equal(withTemplate.status, 200);
  let document = (await withTemplate.json()).document;
  assert.equal(document.templateId, custom.id);

  const evidence = await call(`/api/documents/${document.id}/evidence`, 'POST', { revision: document.revision });
  assert.equal(evidence.status, 200);
  const ledger = (await evidence.json()).evidence;
  assert.equal(ledger.claims.find(claim => claim.plain.includes('本季度收入')).status, 'supported');
  assert.equal(ledger.claims.find(claim => claim.plain.includes('需求增长')).status, 'broken');
  assert.equal((await call(`/api/documents/${document.id}/evidence`, 'POST', { revision: document.revision - 1 })).status, 409);

  const checked = await call(`/api/documents/${document.id}/delivery-check`, 'POST', { revision: document.revision });
  assert.equal(checked.status, 200);
  const result = await checked.json();
  assert.equal(result.report.grade, 'blocked');
  assert.ok(result.report.issues.some(issue => issue.category === 'placeholder'));
  assert.equal(result.forRevision, document.revision);

  bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  document = bootstrap.documents.find(item => item.id === document.id);
  assert.equal(document.evidence.forRevision, document.revision);
  assert.equal(document.delivery.grade, 'blocked');
  assert.equal(document.brief.purpose, '区域复盘');

  const removed = await call(`/api/templates/${custom.id}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.ok(!(await removed.json()).templates.some(item => item.id === custom.id));
  bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.equal(bootstrap.documents.find(item => item.id === document.id).templateId, null);
});

test('自定义模板拒绝缺少正文或章节的内容', async t => {
  const directory = await temporary();
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const call = (path, method, body) => fetch(`${app.url}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': bootstrap.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await call('/api/templates', 'POST', { template: { title: '空模板', sections: [], content: '' } })).status, 400);
  assert.equal((await call('/api/templates', 'POST', { template: { title: '', sections: ['一'], content: '正文' } })).status, 400);
  assert.equal((await call('/api/templates/distill', 'POST', { documentIds: ['missing'] })).status, 404);
});
