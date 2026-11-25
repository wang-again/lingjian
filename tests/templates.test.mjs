import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { integrationMissing } from './fixtures/office-runtime.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { templates, templateResource } from '../lib/templates.mjs';
import { createTestApp } from './fixtures/http.mjs';
import { OfficeService } from '../lib/office.mjs';

test('精选模板的本地文件、来源许可、真实格式与固定校验值完整', async () => {
  const formats = new Set(), ids = new Set();
  for (const template of templates) {
    assert.ok(!ids.has(template.id)); ids.add(template.id);
    assert.ok(template.content && template.rules && template.usage.length);
    if (template.source) {
      assert.ok(template.source.attribution);
      assert.equal(new URL(template.source.url).protocol, 'https:');
      assert.equal(new URL(template.source.licenseUrl).protocol, 'https:');
    }
    for (const asset of template.assets) {
      assert.ok(!('file' in asset)); formats.add(asset.format);
      const resource = templateResource(template.id, asset.id);
      const bytes = resource.bytes || await readFile(resource.path);
      if (asset.generated) { assert.match(bytes.toString(), /## /); continue; }
      assert.equal(bytes.length, asset.size, `${template.id}/${asset.id} 文件大小与目录不一致`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `${template.id}/${asset.id} 文件校验失败，请恢复已登记的原件`);
      if (['DOC', 'XLS'].includes(asset.format)) assert.equal(bytes.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
      if (['DOCX', 'XLSX'].includes(asset.format)) assert.equal(bytes.subarray(0, 2).toString(), 'PK');
      if (asset.format === 'PDF') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      if (asset.format === 'MD') {
        assert.ok(bytes.toString().includes(template.source.attribution));
        assert.match(bytes.toString(), /Permission is hereby granted/);
      }
    }
  }
  assert.deepEqual([...formats].sort(), ['DOC', 'DOCX', 'MD', 'PDF', 'XLS', 'XLSX']);
  assert.equal(templateResource('project-brief', '../server.mjs'), null);
});

test('中文精选提供真实中文文件，编辑器保留各自许可且不泄露内部许可路径', async () => {
  const chinese = templates.filter(item => item.source && item.language === '中文');
  assert.ok(chinese.length >= 10);
  const formats = new Set();
  for (const template of chinese) {
    assert.ok(!('licenseFile' in template.source));
    assert.match(template.content, /[\u4e00-\u9fff]{4}/);
    for (const asset of template.assets) formats.add(asset.format);
    if (template.assets.some(asset => asset.format === 'MD')) {
      assert.match(template.content, /official-document-drafting contributors/);
      assert.doesNotMatch(template.content, /Anton Pycarelle/);
    }
  }
  for (const format of ['MD', 'DOCX', 'PDF', 'XLSX']) assert.ok(formats.has(format));
});

test('模板下载离线可用，导入独立副本、会话校验与旧格式边界', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yanzhi-templates-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('yanzhi-templates-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const post = (id, assetId, token = bootstrap.token) => fetch(`${app.url}/api/templates/${id}/use`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token }, body: JSON.stringify({ assetId }) });
  for (const template of templates) for (const asset of template.assets) {
    const response = await fetch(`${app.url}/api/templates/${template.id}/assets/${asset.id}`);
    assert.equal(response.status, 200, `${template.id}/${asset.id} 下载失败`);
    assert.match(response.headers.get('content-disposition'), /attachment; filename\*=UTF-8''/);
    const bytes = Buffer.from(await response.arrayBuffer());
    const resource = templateResource(template.id, asset.id);
    assert.deepEqual(bytes, resource.bytes || await readFile(resource.path));
  }
  assert.equal((await post('cash-flow', 'workbook', 'wrong-session')).status, 403);
  assert.equal((await post('cash-flow', '../../server.mjs')).status, 404);
  const invalid = await fetch(`${app.url}/api/templates/cash-flow/use`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': bootstrap.token }, body: 'null' });
  assert.equal(invalid.status, 404);
  assert.equal((await fetch(`${app.url}/api/templates/unknown/assets/document`)).status, 404);
  const legacy = await post('project-brief', 'document');
  assert.equal(legacy.status, 400); assert.match((await legacy.json()).error, /DOCX/);
  assert.equal((await post('benefits-tracker', 'workbook')).status, 400);
  const results = [];
  for (const [id, assetId] of [['cash-flow', 'workbook'], ['cash-flow', 'workbook'], ['business-justification', 'document'], ['business-case-checklist', 'checklist'], ['minutes', 'markdown'], ['zh-cash-flow', 'workbook'], ['zh-notice', 'document'], ['zh-notice', 'print'], ['zh-request', 'markdown']]) {
    const response = await post(id, assetId); assert.equal(response.status, 201);
    const result = await response.json(); results.push(result);
    assert.match(result.prompt, /填写要求/);
    const original = templateResource(id, assetId);
    assert.deepEqual(await readFile(await app.office.safePath(result.file.id)), original.bytes || await readFile(original.path));
  }
  assert.notEqual(results[0].file.id, results[1].file.id);
  assert.equal(results.at(-1).files.length, 9);
});

const python = process.env.OFFICE_PYTHON || resolve('.venv-office', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
test('真实模板能被现有工具读取，现金流输入另存后原件及公式保持完整', { skip: integrationMissing, timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yanzhi-templates-'));
  const office = new OfficeService(directory, { python });
  t.after(async () => {
    office.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('yanzhi-templates-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const uploaded = {};
  for (const [id, assetId] of [['cash-flow', 'workbook'], ['business-justification', 'document'], ['business-case-checklist', 'checklist'], ['oss-readme', 'markdown']]) {
    const resource = templateResource(id, assetId);
    uploaded[id] = await office.upload(resource.name, (await readFile(resource.path)).toString('base64'));
  }
  assert.match((await office.extract(uploaded['business-justification'].id)).text, /Business Case/);
  assert.match((await office.extract(uploaded['business-case-checklist'].id)).text, /Checklist/);
  assert.match((await office.extract(uploaded['oss-readme'].id)).text, /Project name/);
  const original = uploaded['cash-flow'].id;
  const read = await office.call('read_xlsx', { file_path: original, sheet_name: 'Cash flow statement' });
  assert.ok(read.data.sheets_available.includes('Using this cash flow statement'));
  assert.match(JSON.stringify(read.data), /OPENING BALANCE/);
  const edited = await office.call('edit_xlsx', { file_path: original, spec_json: JSON.stringify({ sheet: 'Cash flow statement', operations: [{ op: 'set_cell', cell: 'D7', value: 1000 }] }) });
  assert.notEqual(edited.data.output, original);
  await promisify(execFile)(python, ['-c', "import sys; from openpyxl import load_workbook; a=load_workbook(sys.argv[1]); b=load_workbook(sys.argv[2]); assert a.sheetnames==b.sheetnames; assert a['Cash flow statement']['D7'].value==0; assert b['Cash flow statement']['D7'].value==1000; fa={(s.title,c.coordinate):c.value for s in a for row in s for c in row if c.data_type=='f'}; fb={(s.title,c.coordinate):c.value for s in b for row in s for c in row if c.data_type=='f'}; assert fa==fb and len(fa)>0; assert a['Cash flow statement'].merged_cells==b['Cash flow statement'].merged_cells; a.close(); b.close()", await office.safePath(original), await office.safePath(edited.data.output)], { windowsHide: true });
  assert.deepEqual(await readFile(await office.safePath(original)), await readFile(templateResource('cash-flow', 'workbook').path));
});
