import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createTestApp, listenHttp } from './fixtures/http.mjs';
import { validateProvider, modelToolTurn } from '../lib/providers.mjs';

async function fixture(t, handler) {
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    await handler(JSON.parse(body), res, req);
  });
  await listenHttp(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'yanzhi-connection-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => {
    await app.close(); await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); });
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('yanzhi-connection-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const { token } = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const config = validateProvider({ vendor: 'bailian', name: '连接测试', model: 'qwen-plus', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, maxTokens: 8192 });
  return { config, post: (changes = {}) => fetch(`${app.url}/api/providers/test`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token }, body: JSON.stringify({ ...config, apiKey: 'connection-test-secret', ...changes }) }) };
}
const event = value => `data: ${JSON.stringify(value)}\n\n`;

test('测试连接使用勾选的流式模式，支持仅流式的思考模型', async t => {
  const requests = [];
  const { post } = await fixture(t, (input, res) => {
    requests.push(input);
    if (!input.stream) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'InvalidParameter', message: 'parameter.enable_thinking only support stream call' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(event({ choices: [{ delta: { reasoning_content: 'hidden-thinking' } }] }) + event({ choices: [{ delta: { content: '连接成功' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  const response = await post(); const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.preview, '连接成功'); assert.equal(body.diagnostic.stream, true);
  assert.ok(!JSON.stringify(body).includes('hidden-thinking'));
  assert.equal(requests.length, 1); assert.equal(requests[0].max_tokens, 8192);
});

test('连接测试保留非流式与 Responses 配置，不把 JSON 响应误当成 SSE', async t => {
  const inputs = [];
  const { post } = await fixture(t, (input, res) => {
    inputs.push(input); res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(input.input ? { status: 'completed', output_text: '连接成功' } : { choices: [{ message: { content: '连接成功' }, finish_reason: 'stop' }] }));
  });
  for (const changes of [{ stream: false }, { protocol: 'responses', stream: true }]) {
    const response = await post(changes); assert.equal(response.status, 200); assert.equal((await response.json()).preview, '连接成功');
  }
  assert.equal(inputs[0].stream, false); assert.equal(inputs[1].stream, true); assert.equal(inputs[1].store, false);
});

test('连接错误提供上游状态、错误码与请求编号，全部信息去除密钥', async t => {
  const { post } = await fixture(t, (_input, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json', 'x-request-id': 'trace-401' });
    res.end(JSON.stringify({ error: { code: 'InvalidApiKey', message: 'invalid connection-test-secret Bearer connection-test-secret' } }));
  });
  const response = await post(), body = await response.json();
  assert.equal(response.status, 502); assert.match(body.error, /401/);
  assert.equal(body.diagnostic.category, 'authentication');
  assert.equal(body.diagnostic.upstreamStatus, 401); assert.equal(body.diagnostic.upstreamCode, 'InvalidApiKey');
  assert.equal(body.diagnostic.requestId, 'trace-401'); assert.ok(!JSON.stringify(body).includes('connection-test-secret'));
});

test('硅基流动专用追踪响应头也能进入诊断信息', async t => {
  const { post } = await fixture(t, (_input, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'x-siliconcloud-trace-id': 'silicon-trace-429' });
    res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }));
  });
  const response = await post({ vendor: 'siliconflow' }), body = await response.json();
  assert.equal(response.status, 502); assert.equal(body.diagnostic.category, 'quota_or_rate_limit');
  assert.equal(body.diagnostic.requestId, 'silicon-trace-429');
});

test('控制台 HTML 或流式提前断开不会显示连接成功', async t => {
  const { post } = await fixture(t, (input, res) => {
    if (!input.stream) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>console sign in</html>'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(event({ choices: [{ delta: { content: '部分回复' } }] }));
  });
  const html = await post({ stream: false }); assert.equal(html.status, 502); assert.equal((await html.json()).diagnostic.category, 'invalid_response');
  const partial = await post(); assert.equal(partial.status, 502); assert.match((await partial.json()).error, /提前结束/);
});

test('工具规划聚合分片参数与思考内容，兼容仅流式 Chat 模型', async t => {
  const inputs = [];
  const { config } = await fixture(t, (input, res) => {
    inputs.push(input);
    if (!input.stream) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'This model only support stream mode' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(event({ choices: [{ delta: { role: 'assistant', reasoning_content: 'hidden-', tool_calls: [{ index: 0, id: 'call-one', type: 'function', function: { name: 'use_', arguments: '{"skill_' } }] } }] }) + event({ choices: [{ delta: { reasoning_content: 'reasoning', tool_calls: [{ index: 0, function: { name: 'skill', arguments: 'id":"report-writing"}' } }] }, finish_reason: 'tool_calls' }] }) + event({ choices: [], usage: { total_tokens: 31 } }) + 'data: [DONE]\n\n');
  });
  const tool = { name: 'use_skill', description: '加载技能', inputSchema: { type: 'object', properties: { skill_id: { type: 'string' } } } };
  const result = await modelToolTurn(config, 'connection-test-secret', [{ role: 'user', content: '写报告' }], [tool]);
  assert.equal(inputs[0].stream, true); assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0], { id: 'call-one', name: 'use_skill', arguments: '{"skill_id":"report-writing"}' });
  assert.equal(result.append[0].reasoning_content, 'hidden-reasoning'); assert.equal(result.text, ''); assert.equal(result.usage.total_tokens, 31);
});

test('明确关闭流式时保留选择，模型拒绝时给出原因且不自动重试', async t => {
  let count = 0;
  const { post } = await fixture(t, (_input, res) => { count++; res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'InvalidParameter', message: 'This model only support stream mode' } })); });
  const response = await post({ stream: false }), body = await response.json();
  assert.equal(response.status, 502); assert.match(body.error, /启用流式/);
  assert.equal(body.diagnostic.stream, false); assert.equal(body.diagnostic.upstreamStatus, 400); assert.equal(count, 1);
});

test('连接在收到厂商响应前被关闭时，诊断归类为网络错误', async t => {
  const { post } = await fixture(t, (_input, _res, req) => req.socket.destroy());
  const response = await post(), body = await response.json();
  assert.equal(response.status, 502); assert.equal(body.diagnostic.category, 'network');
  assert.ok(body.diagnostic.networkCodes.length); assert.ok(!JSON.stringify(body).includes('connection-test-secret'));
});

test('工具流分片交错时按编号组合，提前断流和达到上限均拒绝执行', async t => {
  const { config } = await fixture(t, (input, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (input.model === 'broken') { res.end(event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'incomplete', function: { name: 'read_file', arguments: '{' } }] } }] })); return; }
    if (input.model === 'truncated') { res.end(event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'truncated', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'length' }] })); return; }
    res.end(event({ choices: [{ delta: { reasoning_content: '', tool_calls: [{ index: 1, id: 'second', function: { name: 'read_file', arguments: '{"path":' } }, { index: 0, id: 'first', function: { name: 'read_file', arguments: '{"path":' } }] } }] }) + event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"甲.md"}' } }, { index: 1, function: { arguments: '"乙.md"}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
  });
  const tools = [{ name: 'read_file', description: '读取', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  const result = await modelToolTurn(config, '', [], tools);
  assert.deepEqual(result.calls.map(call => call.id), ['first', 'second']);
  assert.deepEqual(result.calls.map(call => JSON.parse(call.arguments).path), ['甲.md', '乙.md']);
  assert.equal(result.append[0].reasoning_content, '');
  await assert.rejects(modelToolTurn({ ...config, model: 'broken' }, '', [], tools), /提前结束/);
  await assert.rejects(modelToolTurn({ ...config, model: 'truncated' }, '', [], tools), /长度上限/);
});
