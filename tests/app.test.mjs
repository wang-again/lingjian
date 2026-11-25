import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import http from 'node:http';
import { createTestApp, listenHttp } from './fixtures/http.mjs';
import { createDocx } from '../lib/docx.mjs';
import { providerPresets } from '../lib/provider-presets.mjs';

test('服务商配置从预设到测试连接、写作及重启闭环，推理预算不被缩至 512', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yanzhi-providers-'));
  const requests = [];
  const modelRequests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      modelRequests.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'platform-only-model' }, { id: 'Qwen/Custom-Model' }] })); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ url: req.url, authorization: req.headers.authorization, payload });
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const content = payload.messages.at(-1)?.content === '请只回复：连接成功' ? '连接成功' : '模型正文';
      res.end(`data: {"choices":[{"delta":{"reasoning_content":"fixture-hidden-reasoning"}}]}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '连接成功' }, finish_reason: payload.max_tokens > 512 ? 'stop' : 'length' }] }));
    }
  });
  await listenHttp(upstream);
  let app = await createTestApp({ dataDir: directory });
  t.after(async () => {
    await app.close(); await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); });
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('yanzhi-providers-'));
    await rm(directory, { recursive: true, force: true });
  });
  const bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.deepEqual(bootstrap.providerPresets, providerPresets);
  const call = (path, body) => fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': bootstrap.token }, body: JSON.stringify(body) });
  let writingProvider;
  for (const preset of bootstrap.providerPresets) {
    const input = { ...preset, vendor: preset.id, model: preset.models[0], baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: `test-secret-${preset.id}` };
    const saved = await call('/api/providers', input); assert.equal(saved.status, 200);
    const { provider } = await saved.json();
    assert.equal(provider.vendor, preset.id); assert.equal(provider.hasKey, true);
    assert.ok(!('apiKey' in provider));
    const listing = await call('/api/providers/models', { ...provider, model: '', apiKey: '' });
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json()).models, ['platform-only-model', 'Qwen/Custom-Model']);
    assert.equal(modelRequests.at(-1).authorization, `Bearer test-secret-${preset.id}`);
    assert.equal(modelRequests.at(-1).url, `/v1/models${preset.id === 'siliconflow' ? '?sub_type=chat' : ''}`);
    assert.equal((await call('/api/providers/models', { ...provider, baseUrl: 'https://other.example/v1', apiKey: '' })).status, 400);
    const tested = await call('/api/providers/test', { ...provider, apiKey: '' });
    const result = await tested.json();
    assert.equal(tested.status, 200, JSON.stringify(result)); assert.equal(result.preview, '连接成功');
    const request = requests.at(-1);
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.authorization, `Bearer test-secret-${preset.id}`);
    assert.equal(request.payload.max_tokens, preset.maxTokens); assert.equal(request.payload.stream, true);
    assert.ok(!('vendor' in request.payload));
    if (preset.id === 'deepseek') writingProvider = provider;
  }
  const response = await call('/api/generate', { providerId: writingProvider.id, documentId: bootstrap.documents[0].id, revision: bootstrap.documents[0].revision, mode: 'write', prompt: '撰写文档' });
  const stream = await response.text();
  assert.ok(stream.includes('模型正文')); assert.ok(stream.includes('event: done'));
  assert.ok(!stream.includes('fixture-hidden-reasoning')); assert.ok(!stream.includes('event: error'));
  assert.ok(!(await readFile(join(directory, 'workspace.json'), 'utf8')).includes('test-secret-'));
  await app.close(); app = await createTestApp({ dataDir: directory });
  const restarted = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.deepEqual(restarted.providers.map(item => item.vendor), providerPresets.map(item => item.id));
  assert.ok(restarted.providers.every(item => !item.hasKey));
  assert.ok(restarted.providers.every(item => !('models' in item)));
});

test('工作区端到端：保存配置、引用资料、生成、导出、回滚快照与重启', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yanzhi-test-'));
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    upstreamRequests.push(JSON.parse(input));
    if (upstreamRequests.at(-1).tools) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'准备完成'}}]})); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"## 一、项目目标\\n依据[资料：背景.txt]编写正文。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await listenHttp(upstream);
  let app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close(); await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('yanzhi-test-')); await rm(directory, { recursive: true, force: true }); });
  let bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const call = (path, method, body, extra = {}) => fetch(`${app.url}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': bootstrap.token, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(bootstrap.templates.length >= 20); assert.equal(bootstrap.documents.length, 1);
  assert.equal((await fetch(`${app.url}/`)).status, 200);
  assert.equal((await fetch(`${app.url}/.data/workspace.json`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await call('/api/documents', 'POST', {}, { Origin: 'https://evil.example' })).status, 403);
  const providerResult = await (await call('/api/providers', 'POST', { name: '集成测试配置', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'mock-test-model', apiKey: 'integration-test-secret' })).json();
  assert.equal(providerResult.provider.hasKey, true); assert.ok(!JSON.stringify(providerResult).includes('integration-test-secret'));
  assert.ok(!(await readFile(join(directory, 'workspace.json'), 'utf8')).includes('integration-test-secret'));
  assert.equal((await call('/api/providers/test', 'POST', { ...providerResult.provider, baseUrl: 'https://different.example/v1', apiKey: '' })).status, 400);
  assert.equal((await call('/api/providers', 'POST', { ...providerResult.provider, baseUrl: 'https://different.example/v1', apiKey: '' })).status, 400);
  let doc = bootstrap.documents[0];
  let response = await call(`/api/documents/${doc.id}`, 'PUT', { ...doc, title: '集成测试文档', html: '<h2>原有内容</h2><p>原始正文</p>', sources: [{ id: 'test-source', name: '背景.txt', text: '本项目关注可配置模型的文档工作流。', enabled: true }] });
  assert.equal(response.status, 200); doc = (await response.json()).document;
  assert.equal((await call(`/api/documents/${doc.id}`, 'PUT', { ...doc, revision: 1 })).status, 409);
  const stream = await (await call('/api/generate', 'POST', { providerId: providerResult.provider.id, documentId: doc.id, revision: doc.revision, mode: 'write', prompt: '请结合背景资料编写。' })).text();
  assert.ok(stream.includes('event: delta')); assert.ok(stream.includes('event: done')); assert.ok(!stream.includes('event: error'));
  assert.ok(JSON.stringify(upstreamRequests[0]).includes('背景.txt')); assert.ok(JSON.stringify(upstreamRequests[0]).includes('原始正文'));
  doc = (await (await call(`/api/documents/${doc.id}`, 'PUT', { ...doc, html: '<h2>新内容</h2><p>生成后的正文</p>', snapshot: 'AI 修改前' })).json()).document;
  assert.equal(doc.history.length, 1); assert.ok(doc.history[0].html.includes('原始正文'));
  const snapshot = doc.history[0];
  doc = (await (await call(`/api/documents/${doc.id}`, 'PUT', { ...doc, html: snapshot.html, title: snapshot.title, snapshot: '恢复版本前' })).json()).document;
  assert.ok(doc.html.includes('原始正文')); assert.ok(doc.history[0].html.includes('生成后的正文'));
  response = await call('/api/export/docx', 'POST', { title: doc.title, blocks: [{ type: 'heading', level: 1, text: '可编辑标题' }, { type: 'paragraph', runs: [{ text: '带加粗的文字', bold: true }] }, { type: 'table', rows: [['目标', '标准'], ['文档导出', '可打开']] }] });
  assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').includes('wordprocessingml'));
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.readUInt32LE(0), 0x04034b50); assert.ok(bytes.includes(Buffer.from('可编辑标题'))); assert.ok(bytes.includes(Buffer.from('<w:tbl>')));
  const oldToken = bootstrap.token;
  await app.close(); app = await createTestApp({ dataDir: directory });
  const restartWrite = { ...doc, html: '<p>重启期间的本地编辑</p>' };
  const expired = await call(`/api/documents/${doc.id}`, 'PUT', restartWrite, { 'X-Workspace-Token': oldToken });
  assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, 'WORKSPACE_TOKEN_CHANGED');
  bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.equal(bootstrap.providers.length, 1); assert.equal(bootstrap.providers[0].hasKey, false);
  assert.ok(bootstrap.documents.find(item => item.id === doc.id).html.includes('原始正文'));
  const retried = await call(`/api/documents/${doc.id}`, 'PUT', restartWrite);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).document.html, restartWrite.html);
});

test('Word 输出包含标准部件、正确转义标题与表格内容', () => {
  const bytes = createDocx('A&B <标题>', [{ type: 'list', ordered: false, text: '清单' }, { type: 'quote', text: '引文' }, { type: 'table', rows: [['列一', '列二'], ['A&B', '<文本>']] }]);
  assert.ok(bytes.includes(Buffer.from('A&amp;B &lt;标题&gt;')));
  for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/footer1.xml', 'word/_rels/document.xml.rels']) assert.ok(bytes.includes(Buffer.from(part)));
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
});

test('Word 导出保留第 1001 行及第 51 列，超出支持范围时拒绝导出', () => {
  const rows = Array.from({ length: 1001 }, (_, index) => [`第 ${index + 1} 行`]);
  rows[0] = Array.from({ length: 51 }, (_, index) => `第 ${index + 1} 列`);
  const bytes = createDocx('大表格', [{ type: 'table', rows }]);
  assert.ok(bytes.includes('第 1001 行'));
  assert.ok(bytes.includes('第 51 列'));
  assert.ok(bytes.includes('<w:tblGrid>'));
  assert.throws(() => createDocx('太宽', [{ type: 'table', rows: [Array(64).fill('数据')] }]), { status: 400 });
  const oversized = Array.from({ length: 1000 }, () => Array(51).fill('数据'));
  assert.throws(() => createDocx('太大', [{ type: 'table', rows: oversized }]), /5 万个表格单元格/);
});

test('删除旧版本被拒绝，核对最新版本后才可删除', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-delete-test-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const bootstrap = async () => (await fetch(`${app.url}/api/bootstrap`)).json();
  const { token, documents: [original] } = await bootstrap();
  const request = (method, body) => fetch(`${app.url}/api/documents/${original.id}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token }, body: JSON.stringify(body)
  });
  const update = await request('PUT', { ...original, html: '<p>另一个窗口的新内容</p>' });
  assert.equal(update.status, 200);
  const { document: latest } = await update.json();
  assert.equal((await request('DELETE', {})).status, 400);
  assert.equal((await request('DELETE', { revision: original.revision })).status, 409);
  assert.deepEqual((await bootstrap()).documents, [latest]);
  assert.equal((await request('DELETE', { revision: latest.revision })).status, 200);
  assert.deepEqual((await bootstrap()).documents, []);
});

test('中文长文和参考资料在字段上限内可新建及更新，仍校验字段长度', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-large-document-test-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const request = (path, method, document) => fetch(`${app.url}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token }, body: JSON.stringify(document)
  });
  const html = `<p>${'文'.repeat(999_993)}</p>`;
  const sources = [{ name: '甲', text: '材'.repeat(300_000) }, { name: '乙', text: '料'.repeat(200_000) }];
  const created = await request('/api/documents', 'POST', { title: '长文', html, sources });
  assert.equal(created.status, 201);
  const { document } = await created.json();
  const path = `/api/documents/${document.id}`;
  const updated = await request(path, 'PUT', { ...document, title: '长文更新' });
  assert.equal(updated.status, 200);
  const saved = (await updated.json()).document;
  assert.equal(saved.html, html);
  assert.deepEqual(saved.sources.map(source => source.text), sources.map(source => source.text));
  const tooLong = await request(path, 'PUT', { ...saved, html: `${html}文` });
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json()).error, /正文/);
});
