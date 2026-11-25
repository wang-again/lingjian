import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenHttp } from './fixtures/http.mjs';
import { validateProvider, endpointFor, modelsEndpointFor, listProviderModels, makePayload, parseSSE, runModel, modelToolTurn } from '../lib/providers.mjs';
import { providerPresets } from '../lib/provider-presets.mjs';

const config = changes => validateProvider({ name: '测试模型', baseUrl: 'https://example.com/v1', model: 'test-model', ...changes });
async function mock(handler) {
  const server = http.createServer(handler);
  await listenHttp(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

test('服务商预设可构成有效配置，模型及地址可编辑，旧配置继续兼容', () => {
  const endpoints = {
    bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/chat/completions',
    moonshot: 'https://api.moonshot.cn/v1/chat/completions',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    siliconflow: 'https://api.siliconflow.cn/v1/chat/completions'
  };
  assert.equal(new Set(providerPresets.map(item => item.id)).size, 5);
  for (const preset of providerPresets) {
    const provider = validateProvider({ ...preset, vendor: preset.id, model: preset.models[0] });
    assert.equal(provider.vendor, preset.id);
    assert.equal(endpointFor(provider), endpoints[preset.id]);
    assert.equal(provider.temperature, null);
    const edited = validateProvider({ ...provider, baseUrl: 'http://localhost:8000/v1', model: 'my-other-model' });
    assert.equal(edited.model, 'my-other-model');
    assert.equal(endpointFor(edited), 'http://localhost:8000/v1/chat/completions');
  }
  assert.equal(config({}).vendor, 'custom');
  assert.throws(() => config({ vendor: 'unknown' }), /服务商/);
});

test('模型列表地址适配完整接口、百炼原生目录与硅基对话筛选', () => {
  assert.equal(modelsEndpointFor(config({ baseUrl: 'https://example.com/v1/chat/completions' })).href, 'https://example.com/v1/models');
  assert.equal(modelsEndpointFor(config({ baseUrl: 'https://example.com/v1/responses', protocol: 'responses' })).href, 'https://example.com/v1/models');
  const bailian = modelsEndpointFor(config({ vendor: 'bailian', baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }));
  assert.equal(bailian.pathname, '/api/v1/models'); assert.equal(bailian.searchParams.get('capabilities'), 'TG');
  assert.equal(modelsEndpointFor(config({ vendor: 'siliconflow' })).searchParams.get('sub_type'), 'chat');
});

test('模型列表读取百炼分页、去重并忽略无效 ID，保留组织前缀与大小写', async t => {
  const requests = [];
  const service = await mock((req, res) => {
    requests.push({ url: req.url, method: req.method, key: req.headers.authorization });
    const page = Number(new URL(req.url, 'http://localhost').searchParams.get('page_no'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: { total: 4, models: page === 1
      ? [{ model: 'Qwen/My-Model' }, { model: 'model-2' }]
      : [{ model: 'model-2' }, { model: 'model-10' }] } }));
  }); t.after(service.close);
  const result = await listProviderModels(config({ vendor: 'bailian', baseUrl: service.baseUrl.replace('/v1', '/compatible-mode/v1') }), 'list-test-key');
  assert.deepEqual(result.models, ['model-2', 'model-10', 'Qwen/My-Model']); assert.equal(result.truncated, false);
  assert.equal(requests.length, 2); assert.equal(requests[0].method, 'GET');
  assert.ok(requests[1].url.includes('page_no=2')); assert.ok(requests[0].url.startsWith('/api/v1/models?'));
  assert.equal(requests[0].key, 'Bearer list-test-key');
});

test('模型目录的认证失败、无效返回与空列表提示可手填，错误不会泄漏密钥', async t => {
  for (const kind of ['auth', 'missing', 'invalid', 'empty', 'valid']) {
    const service = await mock((_req, res) => {
      res.writeHead(kind === 'auth' ? 401 : kind === 'missing' ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(kind === 'auth' ? { error: { message: 'invalid list-test-secret' } }
        : kind === 'invalid' ? { data: {} } : { data: kind === 'valid' ? [{ id: 'Valid/Model' }, { id: '' }, { id: 7 }, { id: 'x'.repeat(201) }, { id: 'Valid/Model' }] : [] }));
    }); t.after(service.close);
    if (kind === 'valid') assert.deepEqual((await listProviderModels(config({ baseUrl: service.baseUrl }), '')).models, ['Valid/Model']);
    else await assert.rejects(listProviderModels(config({ baseUrl: service.baseUrl }), 'list-test-secret'), error => {
      assert.ok(!error.message.includes('list-test-secret')); assert.equal(error.status, 502); return true;
    });
  }
});

test('推理模型的多轮工具请求回传 reasoning_content，正文及工具结果保持独立', async t => {
  const requests = [];
  const service = await mock(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    const followup = payload.messages.some(item => item.role === 'tool');
    if (followup && payload.messages.find(item => item.role === 'assistant')?.reasoning_content !== 'fixture-reasoning') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'reasoning_content is required' } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: followup ? 'stop' : 'tool_calls', message: followup
      ? { role: 'assistant', content: '文件已生成', reasoning_content: '' }
      : { role: 'assistant', content: null, reasoning_content: 'fixture-reasoning', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write_docx', arguments: '{}' } }] }
    }] }));
  }); t.after(service.close);
  const provider = config({ vendor: 'deepseek', model: 'deepseek-flash', baseUrl: service.baseUrl });
  const messages = [{ role: 'user', content: '生成 Word' }];
  const tools = [{ name: 'write_docx', description: '创建文档', inputSchema: { type: 'object', properties: {} } }];
  const turn = await modelToolTurn(provider, 'test-key', messages, tools);
  assert.equal(turn.text, ''); assert.equal(turn.calls[0].name, 'write_docx');
  const followup = await modelToolTurn(provider, 'test-key', [...messages, ...turn.append, { role: 'tool', tool_call_id: 'call-1', content: 'ok' }], tools);
  assert.equal(followup.text, '文件已生成'); assert.equal(followup.append[0].reasoning_content, '');
  assert.equal(requests[1].messages[1].reasoning_content, 'fixture-reasoning');
  assert.equal(requests[0].stream, true); assert.equal(requests[0].tools[0].function.name, 'write_docx');
});

test('基础地址和完整地址都正确路由；协议不匹配及 URL 中的凭据被拒绝', () => {
  assert.equal(endpointFor(config({})), 'https://example.com/v1/chat/completions');
  assert.equal(endpointFor(config({ baseUrl: 'https://example.com/v1/chat/completions/' })), 'https://example.com/v1/chat/completions');
  assert.equal(endpointFor(config({ protocol: 'responses' })), 'https://example.com/v1/responses');
  assert.throws(() => endpointFor(config({ baseUrl: 'https://example.com/v1/responses' })), /不匹配/);
  for (const baseUrl of ['file:///secret', 'https://user:password@example.com', 'https://example.com?key=secret']) assert.throws(() => config({ baseUrl }));
  assert.throws(() => config({ temperature: 'abc' }));
});

test('两种协议分别构造请求；默认不发送温度且 Responses 不留存', () => {
  const messages = [{ role: 'user', content: '写文档' }];
  const chat = makePayload(config({ tokenField: 'max_completion_tokens' }), messages);
  assert.equal(chat.max_completion_tokens, 4096); assert.ok(!('max_tokens' in chat)); assert.ok(!('temperature' in chat));
  const responses = makePayload(config({ protocol: 'responses', temperature: 0.3 }), messages);
  assert.equal(responses.store, false); assert.equal(responses.temperature, 0.3); assert.deepEqual(responses.input, messages);
  assert.ok(!('messages' in responses)); assert.ok(!('max_tokens' in makePayload(config({ tokenField: 'omit' }), messages)));
});

test('流式协议可处理逐字节拆开的中文、CRLF 与跨行 data', async () => {
  const buffer = Buffer.from('data: {"text":"中文"}\r\n\r\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n');
  async function* chunks() { for (const byte of buffer) yield Uint8Array.of(byte); }
  const events = []; for await (const event of parseSSE(chunks())) events.push(event);
  assert.deepEqual(events, ['{"text":"中文"}', 'line1\nline2', '[DONE]']);
});

test('Chat 流式输出真实转发文字、用量和认证头', async t => {
  let request;
  const service = await mock(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    request = { url: req.url, authorization: req.headers.authorization, ...JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n');
    res.end('data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
  }); t.after(service.close);
  let usage; const delta = [];
  const result = await runModel(config({ baseUrl: service.baseUrl }), 'test-only-key', [{ role: 'user', content: 'hello' }], { onDelta: text => delta.push(text), onUsage: value => { usage = value; } });
  assert.equal(result, '你好，世界'); assert.deepEqual(delta, ['你好', '，世界']); assert.equal(usage.prompt_tokens, 10);
  assert.equal(request.authorization, 'Bearer test-only-key'); assert.equal(request.url, '/v1/chat/completions');
});

test('Responses 兼容非流式 JSON 和带终态的流式响应', async t => {
  const service = await mock(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    if (payload.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"type":"response.output_text.delta","delta":"可编辑正文"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n'); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '连接成功' }] }] })); }
  }); t.after(service.close);
  const provider = config({ baseUrl: service.baseUrl, protocol: 'responses' });
  assert.equal(await runModel(provider, '', [], { stream: false }), '连接成功');
  assert.equal(await runModel(provider, '', []), '可编辑正文');
});

test('截断、连接断开、认证失败和空正文均不会被报告为完成', async t => {
  for (const kind of ['length', 'disconnect', 'auth', 'empty']) {
    const service = await mock((_req, res) => {
      if (kind === 'auth') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid test-only-secret' } })); }
      else if (kind === 'empty') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}'); }
      else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '部分草稿' }, finish_reason: kind === 'length' ? 'length' : null }] })}\n\n`); }
    });
    try {
      await assert.rejects(runModel(config({ baseUrl: service.baseUrl }), 'test-only-secret', []), error => {
        assert.ok(!error.message.includes('test-only-secret')); return /长度上限|提前结束|密钥无效|没有返回/.test(error.message);
      });
    } finally { await service.close(); }
  }
});

test('取消生成会及时中止上游请求', async t => {
  const service = await mock((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"起稿"}}]}\n\n'); }); t.after(service.close);
  const controller = new AbortController();
  await assert.rejects(runModel(config({ baseUrl: service.baseUrl }), '', [], { signal: controller.signal, onDelta: () => controller.abort() }), /取消/);
});
