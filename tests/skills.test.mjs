import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { skillCatalog, selectSkill, skillInstructions } from '../lib/skills.mjs';
import { runWritingTask } from '../lib/writing.mjs';
import { validateProvider } from '../lib/providers.mjs';
import { OfficeService } from '../lib/office.mjs';
import { createDocx } from '../lib/docx.mjs';
import { createTestApp, listenHttp } from './fixtures/http.mjs';
import { integrationMissing } from './fixtures/office-runtime.mjs';

const python = process.env.OFFICE_PYTHON || resolve('.venv-office', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let runtime = true; try { await access(python); } catch { runtime = false; }
async function cleanup(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('yanzhi-skills-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('技能按任务和入口选择，选区润色与手动禁用不自动变成报告任务', async () => {
  assert.equal(skillCatalog.length, 4);
  assert.equal(selectSkill('auto', { surface: 'writing', prompt: '归纳资料的事实和冲突', mode: 'write' }).id, 'source-synthesis');
  assert.equal(selectSkill('auto', { surface: 'writing', prompt: '生成项目报告', mode: 'write' }).id, 'report-writing');
  assert.equal(selectSkill('auto', { surface: 'writing', prompt: '润色报告', mode: 'rewrite' }), null);
  assert.equal(selectSkill('none', { surface: 'office', prompt: '生成 Word' }), null);
  assert.equal(selectSkill('auto', { surface: 'office', prompt: '检查文件', files: [{ id: 'report.docx' }] }).id, 'docx-delivery');
  assert.throws(() => selectSkill('../secrets', { surface: 'office' }), /技能/);
  assert.throws(() => selectSkill('docx-delivery', { surface: 'writing' }), /技能/);
  const skill = selectSkill('report-writing', { surface: 'office' });
  assert.ok(!skill.tools.includes('delete_file')); assert.ok(!skill.tools.includes('write_xlsx'));
  const officeInstructions = await skillInstructions(skill, { office: true });
  assert.match(officeInstructions, /任务技能：报告撰写/);
  if (!integrationMissing) assert.match(officeInstructions, /content_json/);
  assert.ok(!(await skillInstructions(skill)).includes('# write_docx —'));
});

test('报告技能实际先生成提纲再流式写作，资料范围与原任务保留', async t => {
  const requests = [], events = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const body = JSON.parse(text); requests.push(body);
    if (body.messages.at(-1).content.includes('本次先只输出写作提纲')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '提纲：项目背景、实施方案；依据：背景.txt；负责人待补充。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"# 报告正文\\n依据[资料：背景.txt]撰写。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
    }
  }); await listenHttp(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const config = validateProvider({ name: '模拟模型', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  const document = { title: '项目报告', html: '<p>已确认目标</p>', sources: [{ name: '背景.txt', text: '项目预算 100 元', enabled: true }, { name: '禁用资料', text: '不得发送此段', enabled: false }] };
  const result = await runWritingTask(config, '', document, { mode: 'write', prompt: '请按模板撰写报告', skillId: 'report-writing' }, { onEvent: (kind, data) => events.push({ kind, data }) });
  assert.equal(requests.length, 2); assert.equal(requests[0].stream, true); assert.equal(requests[1].stream, true);
  assert.ok(requests[1].messages.some(message => message.role === 'assistant' && message.content.includes('提纲：项目背景')));
  assert.ok(JSON.stringify(requests[0]).includes('项目预算 100 元')); assert.ok(!JSON.stringify(requests).includes('不得发送此段'));
  assert.ok(result.includes('报告正文')); assert.ok(!events.filter(item => item.kind === 'delta').some(item => item.data.text.includes('提纲：')));
  assert.equal(events.find(item => item.kind === 'skill').data.id, 'report-writing');
  assert.deepEqual(events.filter(item => item.kind === 'usage').at(-1).data, { input_tokens: 10, output_tokens: 6 });
});

test('DOCX 检查实际读取文件，识别缺章、占位符及损坏包，保存报告且不改原件', { skip: !runtime }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yanzhi-skills-')), office = new OfficeService(directory, { python });
  t.after(async () => { office.close(); await cleanup(directory); });
  const original = createDocx('交付检查样例', [{ type: 'heading', level: 1, text: '一、背景' }, { type: 'paragraph', text: '负责人：待补充；预算 100 元。' }, { type: 'table', rows: [['指标', '数值'], ['预算', '100']] }]);
  const file = await office.upload('报告.docx', original.toString('base64'));
  const result = await office.call('check_docx', { file_path: file.id, required_sections: ['背景', '实施方案'] });
  assert.equal(result.data.status, 'needs_review'); assert.equal(result.data.visual_review, false);
  assert.ok(result.data.findings.some(item => item.code === 'placeholder'));
  assert.ok(result.data.findings.some(item => item.code === 'missing_section' && item.message.includes('实施方案')));
  assert.equal(result.data.stats.tables, 1);
  assert.deepEqual(await readFile(await office.safePath(file.id)), original);
  assert.deepEqual(JSON.parse(await readFile(await office.safePath(result.data.report_file), 'utf8')), result.data);
  const clean = await office.upload('完成稿.docx', createDocx('完成稿', [{ type: 'heading', level: 1, text: '背景' }, { type: 'paragraph', text: '项目目标已经明确。' }]).toString('base64'));
  assert.equal((await office.call('check_docx', { file_path: clean.id, required_sections: ['背景'] })).data.status, 'passed');
  const corrupt = await office.upload('损坏.docx', Buffer.from('not-a-docx').toString('base64'));
  assert.equal((await office.call('check_docx', { file_path: corrupt.id })).data.status, 'failed');
  await assert.rejects(office.call('check_docx', { file_path: '../../outside.docx' }), /文件库/);
});

test('资料归纳到 Word 交付：实际读取、生成、自动检查，Chat/Responses 均可通过 HTTP 使用', { skip: integrationMissing, timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yanzhi-skills-')), app = await createTestApp({ dataDir: directory });
  const requests = []; let sourceId = '', scenario = 'normal';
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const input = JSON.parse(text); requests.push(input);
    const responses = req.url.endsWith('/responses'), history = responses ? input.input : input.messages;
    const outputs = history.filter(item => item.role === 'tool' || item.type === 'function_call_output');
    let call;
    if (scenario !== 'fake' && !outputs.length) call = { name: 'read_file', arguments: { path: sourceId } };
    if (scenario !== 'fake' && outputs.length === 1) call = { name: 'write_docx', arguments: { output: `${responses ? 'responses' : 'chat'}-${scenario}.docx`, title: '资料汇总报告', content_json: JSON.stringify(scenario === 'empty' ? [{ type: 'empty' }] : [{ type: 'heading', text: '一、资料摘要' }, { type: 'paragraph', text: '项目预算为 100 元。[资料：预算.txt]' }]) } };
    if (scenario === 'changed' && outputs.length === 2) call = { name: 'write_file', arguments: { path: 'chat-changed.docx', content: 'invalid replacement' } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (responses) res.end(JSON.stringify({ status: 'completed', output: call ? [{ type: 'function_call', call_id: `call-${outputs.length}`, name: call.name, arguments: JSON.stringify(call.arguments) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '报告处理完成。' }] }] }));
    else res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${outputs.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: 'assistant', content: '报告处理完成。' } }] }));
  }); await listenHttp(upstream);
  t.after(async () => { await app.close(); await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }); await cleanup(directory); });
  const boot = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.equal(boot.skills.length, 4); assert.ok(!JSON.stringify(boot.skills).includes('instructions'));
  const call = (path, body) => fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': boot.token }, body: JSON.stringify(body) });
  const uploaded = await (await call('/api/office/upload', { name: '预算.txt', base64: Buffer.from('项目预算 100 元。').toString('base64') })).json(); sourceId = uploaded.file.id;
  for (const protocol of ['chat', 'responses']) {
    const { provider } = await (await call('/api/providers', { name: protocol, protocol, model: 'fixture', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` })).json();
    const stream = await (await call('/api/office/agent', { providerId: provider.id, skillId: 'source-synthesis', prompt: '读取选中资料，归纳并生成 Word 报告', files: [sourceId] })).text();
    assert.ok(stream.includes('event: done'), stream); assert.ok(stream.includes('event: check')); assert.ok(!stream.includes('event: error'), stream);
    const final = requests.at(-1), tools = final.tools.map(tool => tool.name || tool.function?.name);
    assert.ok(tools.includes('read_file')); assert.ok(tools.includes('check_docx')); assert.ok(!tools.includes('write_xlsx'));
    const history = protocol === 'responses' ? final.input : final.messages;
    assert.ok(JSON.stringify(history).includes('deliveryCheck')); assert.ok(JSON.stringify(history).includes('项目预算 100 元'));
    const product = await app.office.extract(`${protocol}-normal.docx`); assert.ok(product.text.includes('项目预算为 100 元'));
    if (protocol === 'chat') {
      scenario = 'fake';
      const fake = await (await call('/api/office/agent', { providerId: provider.id, skillId: 'source-synthesis', prompt: '读取并生成 Word 报告', files: [sourceId] })).text();
      assert.ok(fake.includes('event: error')); assert.ok(!fake.includes('event: done')); assert.ok(!fake.includes('event: delta'));
      scenario = 'empty';
      const empty = await (await call('/api/office/agent', { providerId: provider.id, skillId: 'source-synthesis', prompt: '读取并生成 Word 报告', files: [sourceId] })).text();
      assert.ok(empty.includes('event: check')); assert.ok(empty.includes('event: error')); assert.ok(!empty.includes('event: done'));
      scenario = 'changed';
      const changed = await (await call('/api/office/agent', { providerId: provider.id, skillId: 'none', prompt: '执行文件操作', files: [sourceId] })).text();
      assert.ok(changed.includes('event: error')); assert.ok(!changed.includes('event: done'));
      assert.ok(changed.includes('文件已变化'));
      scenario = 'normal';
    }
  }
});
