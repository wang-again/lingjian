import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { providerPresets } from '../lib/provider-presets.mjs';
import { modelToolTurn } from '../lib/providers.mjs';
import { createTestApp, listenHttp } from './fixtures/http.mjs';

// Independent expectations from the providers' official Chat API documentation.
const paths = {
  bailian: ['/compatible-mode/v1/chat/completions', '/api/v1/models'],
  deepseek: ['/chat/completions', '/models'],
  moonshot: ['/v1/chat/completions', '/v1/models'],
  zhipu: ['/api/paas/v4/chat/completions', '/api/paas/v4/models'],
  siliconflow: ['/v1/chat/completions', '/v1/models']
};
const event = body => `data: ${JSON.stringify(body)}\n\n`;

test('五家厂商逐一经过保存、认证、目录、两种输出模式和工具多轮回归', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yanzhi-provider-matrix-'));
  const seen = [];
  // Each provider uses a separate test prefix while preserving its official path.
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const [, vendor, ...rest] = url.pathname.split('/');
    const route = '/' + rest.join('/'), preset = providerPresets.find(item => item.id === vendor);
    const fail = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); };
    if (!preset || !paths[vendor].includes(route)) return fail(404, 'Unexpected API path');
    if (req.headers.authorization !== `Bearer fake-${vendor}`) return fail(401, 'Wrong provider key');
    if (req.method === 'GET') {
      if (route !== paths[vendor][1]) return fail(404, 'Unexpected models path');
      if (vendor === 'bailian' && (url.searchParams.get('capabilities') !== 'TG' || url.searchParams.get('page_no') !== '1')) return fail(400, 'Missing native catalog parameters');
      if (vendor === 'siliconflow' && url.searchParams.get('sub_type') !== 'chat') return fail(400, 'Missing chat filter');
      seen.push({ vendor, kind: 'models' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(vendor === 'bailian' ? { output: { total: 1, models: [{ model: preset.models[0] }] } } : { data: [{ id: preset.models[0] }] })); return;
    }
    if (route !== paths[vendor][0]) return fail(404, 'Unexpected generation path');
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); seen.push({ vendor, kind: input.tools ? 'tools' : 'test', stream: input.stream });
    if (input.model !== preset.models[0] || 'temperature' in input || 'vendor' in input || input.max_tokens !== preset.maxTokens) return fail(400, 'Incorrect model, defaults or output budget');
    const followup = input.messages.some(message => message.role === 'tool');
    if (followup && input.messages.find(message => message.role === 'assistant')?.reasoning_content !== `thinking-${vendor}`) return fail(400, 'Missing reasoning_content');
    const message = input.tools && !followup
      ? { role: 'assistant', content: null, reasoning_content: `thinking-${vendor}`, tool_calls: [{ id: `${vendor}-call`, type: 'function', function: { name: 'read_file', arguments: '{"path":"资料.md"}' } }] }
      : { role: 'assistant', content: input.tools ? '处理完成' : '连接成功' };
    const reason = message.tool_calls ? 'tool_calls' : 'stop';
    if (!input.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: reason }] })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = { content: message.content, ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
    res.end(event({ choices: [{ delta, finish_reason: reason }] }) + event({ choices: [], usage: { total_tokens: 12 } }) + 'data: [DONE]\n\n');
  });
  await listenHttp(upstream);
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => {
    await app.close(); await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); });
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('yanzhi-provider-matrix-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const { token } = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const post = (path, body) => fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token }, body: JSON.stringify(body) });
  const tools = [{ name: 'read_file', description: '读取', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  for (const preset of providerPresets) await t.test(preset.name, async () => {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/${preset.id}${new URL(preset.baseUrl).pathname.replace(/\/$/, '')}`;
    const saved = await post('/api/providers', { ...preset, id: `matrix-${preset.id}`, vendor: preset.id, baseUrl, model: preset.models[0], apiKey: `fake-${preset.id}` });
    assert.equal(saved.status, 200); const { provider } = await saved.json(); assert.equal(provider.hasKey, true);
    const catalog = await post('/api/providers/models', { ...provider, apiKey: '' });
    assert.equal(catalog.status, 200, JSON.stringify(await catalog.clone().json())); assert.deepEqual((await catalog.json()).models, [preset.models[0]]);
    for (const stream of [true, false]) {
      const response = await post('/api/providers/test', { ...provider, apiKey: '', stream });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.preview, '连接成功'); assert.equal(result.diagnostic.stream, stream);
      const conversation = [{ role: 'user', content: '读取资料' }], config = { ...provider, stream };
      const first = await modelToolTurn(config, `fake-${preset.id}`, conversation, tools);
      assert.equal(first.calls[0].name, 'read_file'); assert.equal(JSON.parse(first.calls[0].arguments).path, '资料.md');
      const final = await modelToolTurn(config, `fake-${preset.id}`, [...conversation, ...first.append, { role: 'tool', tool_call_id: first.calls[0].id, content: '已读取' }], tools);
      assert.equal(final.text, '处理完成');
    }
    assert.equal(seen.filter(item => item.vendor === preset.id && item.kind === 'models').length, 1);
    assert.equal(seen.filter(item => item.vendor === preset.id && item.kind === 'test').length, 2);
    assert.equal(seen.filter(item => item.vendor === preset.id && item.kind === 'tools').length, 4);
  });
});
