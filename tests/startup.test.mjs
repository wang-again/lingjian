import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { listenHttp } from './fixtures/http.mjs';

test('干净源码无需安装依赖即可启动、新建文档并导出可编辑的图文 DOCX', { timeout: 20_000 }, async t => {
  const source = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-startup-'));
  let child, closed;
  t.after(async () => {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^lingjian-startup-/);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all(['package.json', 'server.mjs', 'lib', 'public', 'resources', 'skills'].map(name =>
    cp(join(source, name), join(directory, name), { recursive: true })));
  const packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const [command, ...args] = packageJson.scripts['start:browser'].split(' ');
  assert.equal(command, 'node');
  const probe = createServer();
  await listenHttp(probe);
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, args, {
    cwd: directory, windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', APP_ORIGIN: '', LINGJIAN_AUTH_MODE: 'local' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  closed = once(child, 'close');
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  for (let attempt = 0; !log.includes(url) && attempt < 150 && child.exitCode === null; attempt++) await delay(40);
  assert.ok(log.includes(url), log || '未收到启动地址');
  assert.equal((await fetch(url)).status, 200);
  const workspace = await (await fetch(`${url}/api/bootstrap`)).json();
  const template = workspace.templates.find(item => item.title === '会议纪要');
  assert.ok(template);
  const post = (path, body) => fetch(`${url}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': workspace.token },
    body: JSON.stringify(body)
  });
  const created = await post('/api/documents', { title: '会议纪要示例', templateId: template.id, html: '<p>图前</p><p>图后</p>', sources: [] });
  assert.equal(created.status, 201);
  const { document } = await created.json();
  const png = await readFile(new URL('./fixtures/office/sample.png', import.meta.url));
  const images = [`data:image/png;base64,${png.toString('base64')}`];
  const blocks = [
    { type: 'paragraph', runs: [{ text: '图前' }, { image: { index: 0, width: 80, alt: '现场截图' } }, { text: '图后' }] },
    { type: 'table', rows: [['行动项', '责任人'], ['归档纪要', '记录员']] }
  ];
  const exported = await post('/api/export/docx', { title: document.title, blocks, images });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /wordprocessingml/);
  const bytes = Buffer.from(await exported.arrayBuffer());
  assert.equal(bytes.readUInt32LE(), 0x04034b50);
  assert.ok(bytes.includes(png));
  const zipText = bytes.toString('utf8');
  assert.match(zipText, /图前.*<w:drawing>[\s\S]*?<wp:extent cx="762000" cy="\d+"\/>[\s\S]*?图后/);
  assert.match(zipText, /Target="media\/image1\.png"/);
  assert.match(zipText, /Extension="png" ContentType="image\/png"/);
  assert.match(zipText, /<w:tbl>[\s\S]*?归档纪要/);
  const invalid = await post('/api/export/docx', { title: document.title, blocks, images: ['data:image/png;base64,AAAA'] });
  assert.equal(invalid.status, 400);
});
