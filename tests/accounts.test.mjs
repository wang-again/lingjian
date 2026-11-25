import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createTestApp, listenHttp } from './fixtures/http.mjs';
import { createApp } from '../server.mjs';
import { KeyVault } from '../lib/accounts.mjs';
import { createStore } from '../lib/store.mjs';
import { migrateLegacy } from '../tools/migrate-workspace.mjs';

const password = 'test-password-very-long-2026';
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-accounts-'));
  let app = await createTestApp({ dataDir: directory, authMode: 'accounts', ...options });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('lingjian-accounts-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, get app() { return app; }, async restart(extra = {}) { await app.close(); app = await createTestApp({ dataDir: directory, authMode: 'accounts', ...options, ...extra }); } };
}
async function client(f, username, register = true, extra = {}) {
  const result = await fetch(`${f.app.url}/api/auth/${register ? 'register' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, ...extra }) });
  assert.equal(result.status, 200, await result.clone().text());
  const setCookie = result.headers.get('set-cookie'); assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const bootResponse = await fetch(`${f.app.url}/api/bootstrap`, { headers: { Cookie: cookie } });
  assert.equal(bootResponse.status, 200); const boot = await bootResponse.json();
  return { cookie, boot, call: (path, body, method = 'POST', headers = {}) => fetch(`${f.app.url}${path}`, { method, headers: { Cookie: cookie, 'X-Workspace-Token': boot.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }) };
}

test('账号鉴权、CSRF 与文档/文件/模型密钥隔离；旧工作区保持原样', async t => {
  const f = await fixture(t);
  const legacy = '{"legacy":"private-old-workspace"}'; await writeFile(join(f.directory, 'workspace.json'), legacy);
  for (const path of ['/api/bootstrap', '/api/office/files', '/api/office/file?id=private.txt']) assert.equal((await fetch(`${f.app.url}${path}`)).status, 401);
  assert.equal((await fetch(`${f.app.url}/`)).status, 200);
  const a = await client(f, 'alice'), b = await client(f, 'bob');
  assert.notEqual(a.boot.user.id, b.boot.user.id); assert.notEqual(a.boot.documents[0].id, b.boot.documents[0].id);
  assert.equal(await readFile(join(f.directory, 'workspace.json'), 'utf8'), legacy);
  const accountFile = await readFile(join(f.directory, 'accounts.json'), 'utf8'); assert.ok(!accountFile.includes(password)); assert.match(accountFile, /"salt"/);
  const doc = a.boot.documents[0];
  assert.equal((await b.call(`/api/documents/${doc.id}`, { ...doc, title: 'stolen' }, 'PUT')).status, 404);
  assert.equal((await a.call('/api/documents', {}, 'POST', { 'X-Workspace-Token': b.boot.token })).status, 403);
  assert.equal((await a.call('/api/documents', {}, 'POST', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.call('/api/documents', {}, 'POST', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const file = (await (await a.call('/api/office/upload', { name: 'private.txt', base64: Buffer.from('alice private file').toString('base64') })).json()).file;
  assert.ok(file?.id);
  assert.equal(await (await a.call(`/api/office/file?id=${encodeURIComponent(file.id)}`, undefined, 'GET')).text(), 'alice private file');
  const foreignDownload = await b.call(`/api/office/file?id=${encodeURIComponent(file.id)}`, undefined, 'GET');
  assert.ok([400, 404].includes(foreignDownload.status));
  assert.deepEqual((await (await b.call('/api/office/files', undefined, 'GET')).json()).files, []);
  assert.equal((await b.call('/api/office/file?id=../../workspace.json', undefined, 'GET')).status, 400);
  const requests = [];
  const upstream = http.createServer((req, res) => { requests.push(req.headers.authorization); res.end(JSON.stringify({ choices: [{ message: { content: '连接成功' } }] })); });
  await listenHttp(upstream); t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const config = { id: 'same-id', name: 'test', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'fixture', stream: false };
  for (const [user, key] of [[a, 'alice-secret-value'], [b, 'bob-secret-value']]) {
    const saved = await user.call('/api/providers', { ...config, apiKey: key }); assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes(key));
    assert.equal((await user.call('/api/providers/test', config)).status, 200);
  }
  assert.deepEqual(requests, ['Bearer alice-secret-value', 'Bearer bob-secret-value']);
  assert.ok(!(await readFile(join(f.directory, 'users', a.boot.user.id, 'workspace.json'), 'utf8')).includes('alice-secret-value'));
  const aSecond = await client(f, 'alice', false);
  assert.equal(aSecond.boot.providers[0].hasKey, false, '未记住的密钥不共享给其他登录会话');
  assert.equal((await a.call('/api/providers/test', { ...config, baseUrl: 'https://another.example/v1' })).status, 400);
  assert.equal((await a.call('/api/auth/logout', {})).status, 200);
  assert.equal((await a.call('/api/bootstrap', undefined, 'GET')).status, 401);
  assert.equal((await b.call('/api/bootstrap', undefined, 'GET')).status, 200);
});

test('加密密钥跨重启可用，不返回明文；清除后所有会话失效', async t => {
  const master = randomBytes(32).toString('base64'), f = await fixture(t, { keyEncryptionKey: master });
  let a = await client(f, 'alice');
  const config = { name: 'remember', baseUrl: 'https://api.deepseek.com', model: 'fixture', apiKey: 'encrypted-test-secret', rememberKey: true };
  const saved = await (await a.call('/api/providers', config)).json(); assert.equal(saved.provider.keySaved, true);
  const vaultFile = join(f.directory, 'users', a.boot.user.id, 'keys.json'), cipherText = await readFile(vaultFile, 'utf8');
  assert.ok(!cipherText.includes(config.apiKey)); assert.ok(!cipherText.includes(master)); assert.match(cipherText, /"tag"/);
  const oldCookie = a.cookie;
  await f.restart();
  assert.equal((await fetch(`${f.app.url}/api/bootstrap`, { headers: { Cookie: oldCookie } })).status, 401);
  a = await client(f, 'alice', false); assert.equal(a.boot.providers[0].hasKey, true); assert.equal(a.boot.providers[0].keySaved, true);
  assert.ok(!JSON.stringify(a.boot).includes(config.apiKey));
  const vault = await new KeyVault(vaultFile, a.boot.user.id, Buffer.from(master, 'base64')).init();
  assert.equal(vault.get(saved.provider.id, new URL(config.baseUrl).origin), config.apiKey);
  assert.equal(vault.get(saved.provider.id, 'https://evil.example'), '');
  const foreign = await new KeyVault(vaultFile, 'another-user', Buffer.from(master, 'base64')).init();
  assert.throws(() => foreign.get(saved.provider.id, new URL(config.baseUrl).origin), /无法解密/);
  const b = await client(f, 'alice', false); assert.equal(b.boot.providers[0].hasKey, true);
  assert.equal((await a.call(`/api/providers/${saved.provider.id}/key`, undefined, 'DELETE')).status, 200);
  const after = await (await b.call('/api/bootstrap', undefined, 'GET')).json();
  assert.equal(after.providers[0].hasKey, false); assert.equal(after.providers[0].keySaved, false);
  assert.deepEqual(JSON.parse(await readFile(vaultFile, 'utf8')), {});
  assert.equal((await a.call('/api/providers', { ...saved.provider, apiKey: 'new-session-secret' })).status, 200);
  await f.restart(); a = await client(f, 'alice', false); assert.equal(a.boot.providers[0].hasKey, false);
});

test('未配置主密钥时拒绝持久保存；会话空闲/绝对过期清除密钥', async t => {
  let now = Date.now(); const f = await fixture(t, { sessionOptions: { now: () => now, idleMs: 1000, sessionMs: 3000 } });
  const a = await client(f, 'alice');
  const config = { name: 'test', baseUrl: 'https://api.deepseek.com', model: 'fixture', apiKey: 'session-secret' };
  assert.equal((await a.call('/api/providers', { ...config, rememberKey: true })).status, 400);
  assert.equal((await a.call('/api/providers', config)).status, 200);
  const session = f.app.accounts.authenticate(a.cookie); assert.equal(session.keys.size, 1);
  now += 1001; assert.equal((await a.call('/api/bootstrap', undefined, 'GET')).status, 401); assert.equal(session.keys.size, 0);
  const b = await client(f, 'alice', false); assert.equal(b.boot.providers[0].hasKey, false);
  for (let i = 0; i < 4; i++) { now += 900; const response = await b.call('/api/bootstrap', undefined, 'GET'); assert.equal(response.status, i === 3 ? 401 : 200); }
});

test('注册邀请码、密码验证与账号限流', async t => {
  const f = await fixture(t, { inviteCode: 'test-invitation' });
  const post = body => fetch(`${f.app.url}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ username: 'alice', password })).status, 403);
  assert.equal((await post({ username: 'alice', password: 'short', inviteCode: 'test-invitation' })).status, 400);
  assert.equal((await post(null)).status, 400);
  const a = await client(f, 'alice', true, { inviteCode: 'test-invitation' });
  const wrong = await fetch(`${f.app.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'wrong-password-long-enough' }) });
  assert.equal(wrong.status, 401);
  for (let i = 0; i < 30; i++) assert.equal((await a.call('/api/generate', {})).status, 400);
  assert.equal((await a.call('/api/generate', {})).status, 429);
  for (let i = 0; i < 15; i++) await post({ username: 'alice', password });
  assert.equal((await post({ username: 'alice', password })).status, 429);
});

test('公共部署必须使用账号/HTTPS来源和受控注册', async () => {
  await assert.rejects(createApp({ authMode: 'local', listenHost: '0.0.0.0' }), /单机模式禁止/);
  await assert.rejects(createApp({ authMode: 'accounts', listenHost: '0.0.0.0', publicOrigin: '' }), /HTTPS/);
  await assert.rejects(createApp({ authMode: 'accounts', publicOrigin: 'http://docs.example.com' }), /HTTPS/);
  await assert.rejects(createApp({ authMode: 'accounts', publicOrigin: 'https://docs.example.com' }), /REGISTRATION_INVITE_CODE/);
  await assert.rejects(createApp({ keyEncryptionKey: 'not-a-real-master-key' }), /Base64/);
});

test('HTTPS 代理部署：安全 Cookie、Host/Origin 校验和模型域名白名单', async t => {
  const f = await fixture(t, { publicOrigin: 'https://docs.example.com', inviteCode: 'invite-test' });
  const send = (path, body, extra = {}) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: f.app.server.address().port, path, method: body === undefined ? 'GET' : 'POST', headers: { Host: 'docs.example.com', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra } }, response => {
      let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(text) }));
    });
    request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await send('/api/auth/status', undefined, { Host: 'evil.example', 'X-Forwarded-Host': 'docs.example.com' })).status, 403);
  assert.equal((await send('/api/auth/status', undefined, { Origin: 'https://evil.example' })).status, 403);
  const registration = await send('/api/auth/register', { username: 'alice', password, inviteCode: 'invite-test' }, { Origin: 'https://docs.example.com' });
  assert.equal(registration.status, 200); assert.match(registration.headers['set-cookie'][0], /; Secure$/);
  const cookie = registration.headers['set-cookie'][0].split(';')[0];
  const boot = await send('/api/bootstrap', undefined, { Cookie: cookie }), headers = { Cookie: cookie, 'X-Workspace-Token': boot.data.token };
  for (const baseUrl of ['http://127.0.0.1:3210', 'https://evil.example/v1', 'https://api.deepseek.com.evil.example', 'https://api.deepseek.com:3210']) {
    const result = await send('/api/providers', { name: 'blocked', model: 'fixture', baseUrl, apiKey: 'never-send-this-key' }, headers);
    assert.equal(result.status, 403); assert.ok(!JSON.stringify(result.data).includes('never-send-this-key'));
  }
  assert.equal((await send('/api/providers', { name: 'allowed', model: 'fixture', baseUrl: 'https://api.deepseek.com', apiKey: 'local-test-key' }, headers)).status, 200);
});

test('并发任务按账号限额，退出会中止待完成的模型请求', async t => {
  const f = await fixture(t), a = await client(f, 'alice');
  let arrivals = 0, bothArrived; const ready = new Promise(resolve => bothArrived = resolve);
  const upstream = http.createServer((req, res) => { if (++arrivals === 2) bothArrived(); req.resume(); });
  await listenHttp(upstream); t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const config = { name: 'slow', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'fixture', stream: false };
  const saved = await (await a.call('/api/providers', config)).json();
  const running = [0, 1].map(() => a.call('/api/providers/test', saved.provider).then(response => response.text()).catch(() => 'aborted'));
  await ready;
  assert.equal((await a.call('/api/providers/test', saved.provider)).status, 429);
  assert.equal((await a.call('/api/auth/logout', {})).status, 200);
  assert.deepEqual(await Promise.all(running), ['aborted', 'aborted']);
});

test('旧数据迁移先预览、可重试且不覆盖；运行中的数据目录禁止迁移/第二实例', async t => {
  const f = await fixture(t), a = await client(f, 'alice');
  await assert.rejects(createTestApp({ dataDir: f.directory, authMode: 'accounts' }), /锁定/);
  await assert.rejects(migrateLegacy({ dataDir: f.directory, username: 'alice' }), /锁定/);
  const legacy = await createStore(f.directory); legacy.state.documents[0].title = '旧工作区文档'; await legacy.persist();
  await mkdir(join(f.directory, 'office', 'files'), { recursive: true });
  await writeFile(join(f.directory, 'office', 'files', 'old.txt'), '旧文件原始内容');
  await writeFile(join(f.directory, 'office', 'labels.json'), JSON.stringify({ 'old.txt': '旧文件.txt' }));
  const snapshot = await readFile(legacy.file, 'utf8');
  await f.app.close();
  const preview = await migrateLegacy({ dataDir: f.directory, username: 'alice' }); assert.equal(preview.documentsToAdd, 1); assert.equal(preview.filesToCopy, 1); assert.equal(preview.applied, false);
  const targetFile = join(f.directory, 'users', a.boot.user.id, 'workspace.json');
  assert.equal(JSON.parse(await readFile(targetFile, 'utf8')).documents.length, 1);
  const applied = await migrateLegacy({ dataDir: f.directory, username: 'alice', apply: true }); assert.equal(applied.documentsToAdd, 1);
  const migratedOffice = join(f.directory, 'users', a.boot.user.id, 'office');
  assert.equal(await readFile(join(migratedOffice, 'files', 'old.txt'), 'utf8'), '旧文件原始内容');
  assert.equal(JSON.parse(await readFile(join(migratedOffice, 'labels.json'), 'utf8'))['old.txt'], '旧文件.txt');
  const repeated = await migrateLegacy({ dataDir: f.directory, username: 'alice', apply: true }); assert.equal(repeated.documentsToAdd, 0); assert.equal(repeated.filesToCopy, 0);
  assert.equal(await readFile(legacy.file, 'utf8'), snapshot);
  legacy.state.documents[0].title = '同 ID 不同内容'; await legacy.persist();
  await assert.rejects(migrateLegacy({ dataDir: f.directory, username: 'alice', apply: true }), /未覆盖/);
  assert.ok((await readFile(targetFile, 'utf8')).includes('旧工作区文档'));
});
