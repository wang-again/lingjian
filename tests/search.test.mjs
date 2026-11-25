import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename, dirname } from 'node:path';
import { OfficeService } from '../lib/office.mjs';
import { runOfficeAgent } from '../lib/office-agent.mjs';
import { integrationMissing } from './fixtures/office-runtime.mjs';
import { validateProvider } from '../lib/providers.mjs';
import { listenHttp } from './fixtures/http.mjs';

const python = process.env.OFFICE_PYTHON || resolve('.venv-office', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let runtime = true; try { await access(python); } catch { runtime = false; }
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'yanzhi-search-')), office = new OfficeService(directory, { python });
  t.after(async () => { office.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('yanzhi-search-')); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { directory, office };
}

test('实际检索七种格式，返回段落、页码、单元格、幻灯片和文本位置，原件不变', { skip: !runtime, timeout: 90000 }, async t => {
  const { directory, office } = await setup(t), fixtures = join(directory, 'fixtures');
  await promisify(execFile)(python, [resolve('tests/fixtures/office_samples.py'), fixtures], { windowsHide: true });
  const ids = [];
  for (const extension of ['docx', 'xlsx', 'pptx', 'pdf', 'txt']) {
    ids.push((await office.upload(`资料.${extension}`, (await readFile(join(fixtures, `sample.${extension}`))).toString('base64'))).id);
  }
  ids.push((await office.upload('预算.csv', Buffer.from('项目,金额\n预算,100\n').toString('base64'))).id);
  ids.push((await office.upload('计划.md', Buffer.from('# 计划\n预算已确认。\n').toString('base64'))).id);
  const before = await Promise.all(ids.map(async id => readFile(await office.safePath(id))));
  const { data } = await office.call('search_sources', { files: ids, query: '原始 120 Office 参考 预算', limit: 50 });
  assert.equal(data.files_examined.length, 7);
  for (const id of ids) assert.ok(data.results.some(hit => hit.file === id), id);
  assert.ok(data.results.some(hit => hit.location === '工作表「数据」，单元格 B2' && hit.excerpt === '120'));
  assert.ok(data.results.some(hit => hit.location === '页 1' && hit.excerpt.includes('Office')));
  assert.ok(data.results.some(hit => hit.location === '段落 3' && hit.excerpt.includes('原始内容')));
  assert.ok(data.results.some(hit => hit.location.startsWith('幻灯片 1')));
  assert.ok(data.results.some(hit => hit.location === 'CSV 记录 2'));
  assert.ok(data.results.some(hit => hit.location === '行 2' && hit.name === '计划.md'));
  assert.ok(data.results.every(hit => hit.citation.includes(hit.location) && hit.citation.includes(hit.name)));
  assert.ok(data.warnings.some(warning => warning.message.includes('未重算')));
  for (let i = 0; i < ids.length; i++) assert.deepEqual(await readFile(await office.safePath(ids[i])), before[i]);
  const limited = await office.call('search_sources', { files: ids, query: 'Office', limit: 1 });
  assert.equal(limited.data.results.length, 1); assert.equal(limited.data.more_matches, true);
  const empty = await office.call('search_sources', { files: ids, query: '这段文字并不存在于任何文件' });
  assert.deepEqual(empty.data.results, []);
  await assert.rejects(office.call('search_sources', { files: ['../../outside.txt'], query: '预算' }), /文件库/);
  await assert.rejects(office.call('search_sources', { files: ids, query: '', limit: 2 }), /检索词/);
  await assert.rejects(office.call('search_sources', { files: ids, query: '预算', limit: 51 }), /数量/);
});

test('技能可以利用检索引用完成任务，不能检索未选中的文件', { skip: integrationMissing, timeout: 90000 }, async t => {
  const { office } = await setup(t);
  const file = await office.upload('预算说明.txt', Buffer.from('项目预算为 100 元。').toString('base64'));
  const hidden = await office.upload('未选中的资料.txt', Buffer.from('private-unselected-content').toString('base64'));
  let target = file.id; const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const input = JSON.parse(body); requests.push(input);
    const output = input.messages.find(message => message.role === 'tool');
    const message = output ? { role: 'assistant', content: output.content } : { role: 'assistant', content: null, tool_calls: [{ id: 'search-call', type: 'function', function: { name: 'search_sources', arguments: JSON.stringify({ files: [target], query: '预算' }) } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: output ? 'stop' : 'tool_calls', message }] }));
  }); await listenHttp(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const config = validateProvider({ name: '模拟检索', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  const events = [];
  await runOfficeAgent(config, '', office, { skillId: 'source-synthesis', prompt: '检索预算并归纳依据', files: [file] }, { onEvent: (kind, data) => events.push({ kind, data }) });
  assert.ok(events.some(event => event.kind === 'delta' && event.data.text.includes('预算说明.txt；行 1')));
  assert.ok(JSON.stringify(requests).includes('matched_passages'));
  target = hidden.id;
  await assert.rejects(runOfficeAgent(config, '', office, { skillId: 'source-synthesis', prompt: '检索预算并归纳依据', files: [file] }), /尚未成功读取/);
  assert.ok(requests.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('只能检索')));
  assert.ok(!JSON.stringify(requests).includes('private-unselected-content'));
});
