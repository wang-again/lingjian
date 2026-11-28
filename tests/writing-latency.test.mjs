import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runWritingTask } from '../lib/writing.mjs';
import { validateProvider } from '../lib/providers.mjs';
import { listenHttp } from './fixtures/http.mjs';

const document = { title: '资料报告', html: '<p>预算 100 元</p>', sources: [{ name: '依据.txt', text: '已确认预算 100 元', enabled: true }, { name: '未启用', text: 'hidden-source', enabled: false }] };
async function model(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input); handler(input, res, requests.length);
  });
  await listenHttp(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, config: protocol => validateProvider({ name: '延迟回归', model: 'fixture', protocol, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }) };
}
function draft(input, res, content = '改写正文') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const values = input.input ? [{ type: 'response.output_text.delta', delta: content }, { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 1 } } }]
    : [{ choices: [{ delta: { reasoning_content: 'private-thinking' } }] }, { choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }];
  res.end(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
}
function skills(input, res, ids, ready = true) {
  const calls = ids.map((id, index) => ({ id: `load-${index}`, type: 'function', function: { name: 'use_skill', arguments: JSON.stringify({ skill_id: id, ready_for_writing: ready && index === ids.length - 1 }) } }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(input.input ? { status: 'completed', output: calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })) } : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }] }));
}

test('润色、续写、大纲、审阅均单次请求开始流式输出，保留选区和资料边界', async t => {
  const { requests, config } = await model(t, (input, res) => draft(input, res));
  for (const protocol of ['chat', 'responses']) for (const mode of ['rewrite', 'continue', 'outline', 'review']) {
    const before = requests.length, events = [];
    const text = await runWritingTask(config(protocol), '', document, { mode, prompt: '按当前任务处理', selection: mode === 'rewrite' ? '预算 100 元' : '' }, { onEvent: (kind, data) => events.push({ kind, data }) });
    assert.equal(requests.length - before, 1); assert.equal(requests.at(-1).tools, undefined); assert.equal(requests.at(-1).stream, true);
    assert.equal(text, '改写正文'); assert.equal(JSON.stringify(requests.at(-1)).includes('已确认预算 100 元'), mode !== 'rewrite'); assert.ok(!JSON.stringify(requests.at(-1)).includes('hidden-source'));
    const history = requests.at(-1).messages || requests.at(-1).input;
    const context = JSON.parse(history[1].content); assert.equal(context.selectedText, mode === 'rewrite' ? '预算 100 元' : '');
    const timeline = events.filter(item => item.kind === 'activity').map(item => item.data);
    assert.deepEqual(timeline[0].files, mode === 'rewrite' ? [] : ['依据.txt']);
    assert.equal(timeline[0].label, '准备写作上下文');
    assert.equal(timeline[1].status, 'running');
    assert.equal(timeline.at(-1).id, timeline[1].id);
    assert.equal(timeline.at(-1).status, 'done');
    assert.doesNotMatch(JSON.stringify(events), /private-thinking|hidden-source|未启用|已确认预算/);
    if (protocol === 'chat') assert.equal(events.filter(item => item.kind === 'step' && item.data.phase === 'thinking').length, 1);
  }
});

test('定向写作精简请求并保留指定来源，润色只带可定位的近邻', async t => {
  const { requests, config } = await model(t, (input, res) => {
    const characters = JSON.stringify(input.messages || input.input).length;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '正文' }, finish_reason: 'stop' }], usage: { prompt_tokens: characters, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 17 } } })}\n\ndata: [DONE]\n\n`);
  });
  const fixture = {
    title: '预算通知',
    html: `<p>无关正文${'远'.repeat(2000)}</p><p>现场语境</p><p>请确认预算</p><p>下一段语境</p>`,
    sources: [
      { name: '预算.txt', text: `${'远'.repeat(6000)}项目预算 100 万${'远'.repeat(6000)}` },
      { name: '指定依据.txt', text: '责任人为财务组' },
      { name: '无关.txt', text: '无关资料内容' },
      { name: '停用.txt', text: '项目预算 300 万', enabled: false }
    ]
  };
  const write = { mode: 'write', skillId: 'none', prompt: '写通知并参考指定依据.txt' };
  const usage = [];
  const run = input => runWritingTask(config('chat'), '', fixture, input, { onEvent: (kind, data) => { if (kind === 'usage') usage.push(data); } });
  const context = () => JSON.parse(requests.at(-1).messages[1].content);
  await run(write);
  await run({ ...write, sourceQuery: '项目预算' });
  assert.deepEqual(context().sources.map(source => source.name), ['预算.txt', '指定依据.txt']);
  assert.match(context().sources[0].text, /项目预算 100 万/);
  assert.equal(context().sources[0].excerpt, true);
  assert.equal(context().sources[1].text, '责任人为财务组');
  assert.ok(usage[1].input_tokens < usage[0].input_tokens);
  assert.equal(usage[1].cached_tokens, 17);
  await run({ ...write, sourceQuery: 'zzz-no-match' });
  assert.equal(context().sourceScope, 'no-match');
  assert.equal(context().sources.length, 3);
  await run({ mode: 'rewrite', prompt: '润色', selection: '请确认预算' });
  assert.equal(context().currentDocument, '');
  assert.match(context().surroundingText.before, /现场语境/);
  assert.match(context().surroundingText.after, /下一段语境/);
  assert.equal(context().sources.length, 0);
  await run({ mode: 'rewrite', prompt: '按照资料核对', selection: '请确认预算' });
  assert.equal(context().sources.length, 3);
});

test('模型标记选齐技能后直接写作，不再调用准备确认轮次', async t => {
  const { requests, config } = await model(t, (input, res) => input.tools ? skills(input, res, ['source-synthesis']) : draft(input, res, '归纳正文'));
  for (const protocol of ['chat', 'responses']) {
    const before = requests.length;
    const text = await runWritingTask(config(protocol), '', document, { mode: 'write', prompt: '归纳资料' });
    assert.equal(requests.length - before, 2); assert.equal(text, '归纳正文');
    assert.ok((requests.at(-1).messages || requests.at(-1).input)[0].content.includes('任务技能：资料归纳'));
  }
});

test('英语输出可独立于提示词语言，Chat 和 Responses 都使用英文写作规则', async t => {
  const { requests, config } = await model(t, (input, res) => draft(input, res, 'The budget is approved.'));
  for (const protocol of ['chat', 'responses']) {
    const result = await runWritingTask(config(protocol), '', document, {
      mode: 'continue', prompt: '继续写预算说明', outputLanguage: 'en'
    });
    const history = requests.at(-1).messages || requests.at(-1).input;
    assert.match(history[0].content, /Write the requested output in English/);
    assert.match(history[0].content, /\[Source: filename\]/);
    assert.match(history.at(-1).content, /继续写预算说明/);
    assert.equal(result, 'The budget is approved.');
  }
});

test('组合报告技能省掉确认请求，仍先生成提纲且兼容仅流式模型', async t => {
  const { requests, config } = await model(t, (input, res) => {
    if (input.tools) return skills(input, res, ['source-synthesis', 'report-writing']);
    if (!input.stream) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"only support stream mode"}}'); return; }
    const history = input.messages || input.input;
    draft(input, res, history.at(-1).content.includes('本次先只输出写作提纲') ? '提纲：预算依据与实施方案，责任人待补充。' : '最终报告正文');
  });
  const events = [];
  const text = await runWritingTask(config('chat'), '', document, { mode: 'write', prompt: '根据资料撰写报告' }, { onEvent: (kind, data) => events.push({ kind, data }) });
  assert.equal(requests.length, 3); assert.equal(text, '最终报告正文');
  assert.ok(requests.at(-1).messages[0].content.includes('任务技能：资料归纳')); assert.ok(requests.at(-1).messages[0].content.includes('任务技能：报告撰写'));
  assert.ok(requests.at(-1).messages.some(message => message.role === 'assistant' && message.content.includes('提纲：预算依据')));
  assert.ok(events.filter(item => item.kind === 'delta').every(item => !item.data.text.includes('提纲：')));
  const steps = events.filter(item => item.kind === 'activity').map(item => item.data);
  assert.deepEqual(steps.filter(item => item.label === '加载平台技能').map(item => item.detail), ['资料归纳', '报告撰写']);
  const outline = steps.findIndex(item => item.label === '整理资料依据与报告提纲' && item.status === 'done');
  const drafting = steps.findIndex(item => item.label === '起草正文' && item.status === 'running');
  assert.ok(outline >= 0 && outline < drafting);
});

test('准备失败不能被 ready 标记跳过，模型可以修正后继续', async t => {
  let rounds = 0;
  const { requests, config } = await model(t, (input, res) => input.tools ? skills(input, res, [++rounds === 1 ? '../invalid' : 'source-synthesis']) : draft(input, res));
  const events = [];
  assert.equal(await runWritingTask(config('chat'), '', document, { mode: 'write', prompt: '整理资料' }, { onEvent: (kind, data) => events.push({ kind, data }) }), '改写正文');
  assert.equal(requests.length, 3);
  assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.content.includes('只能加载')));
  assert.ok(events.some(event => event.kind === 'activity' && event.data.status === 'failed'));
  assert.ok(events.some(event => event.kind === 'activity' && event.data.status === 'done' && event.data.detail === '资料归纳'));
});
