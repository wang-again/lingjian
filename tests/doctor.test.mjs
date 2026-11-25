import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { listenHttp } from './fixtures/http.mjs';

test('环境自检区分阻断启动和可降级问题，使用实际配置并清理写入探针', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingjian-doctor-'));
  const listener = createServer();
  await listenHttp(listener);
  const { port } = listener.address();
  t.after(async () => {
    await new Promise(resolve => listener.close(resolve));
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('lingjian-doctor-'));
    await rm(root, { recursive: true, force: true });
  });
  const toolDirectory = join(root, '.vendor', 'office-tool');
  for (const directory of [join(root, 'tools'), join(root, 'lib'), toolDirectory]) await mkdir(directory, { recursive: true });
  for (const file of ['tools/doctor.mjs', 'lib/runtime.mjs']) {
    await copyFile(new URL(`../${file}`, import.meta.url), join(root, file));
  }
  await writeFile(join(root, '.env'), 'PORT=invalid\n');
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), OFFICE_TOOL_DIR: toolDirectory, OFFICE_PYTHON: join(root, 'missing-python') };
  const check = async (args = [], environment = env) => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'tools/doctor.mjs'), ...args], { cwd: root, env: environment, windowsHide: true });
      return { status: 0, stdout };
    } catch (error) {
      return { status: error.code, stdout: error.stdout };
    }
  };

  const busy = await check(['--startup']);
  assert.equal(busy.status, 1);
  assert.match(busy.stdout, new RegExp(`${port} 已被占用`));
  assert.deepEqual(await readdir(join(root, '.data')), []);

  const invalid = await check(['--startup'], { ...env, PORT: '70000' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /PORT 必须/);

  const temporaryListener = createServer();
  await listenHttp(temporaryListener);
  const freePort = temporaryListener.address().port;
  await new Promise(resolve => temporaryListener.close(resolve));
  const freeEnv = { ...env, PORT: String(freePort) };
  const withoutOffice = await check([], freeEnv);
  assert.equal(withoutOffice.status, 0);
  assert.match(withoutOffice.stdout, /\[跳过\] Office 工具/);
  await writeFile(join(toolDirectory, 'server.py'), '# test installation');
  assert.equal((await check([], freeEnv)).status, 1);
  const degraded = await check(['--startup'], freeEnv);
  assert.equal(degraded.status, 0);
  assert.match(degraded.stdout, /\[警告\] Office Python.*安装Office依赖/);
  assert.deepEqual(await readdir(join(root, '.data')), []);

  const marker = 'existing lock';
  const lock = join(root, '.data', '.service.lock');
  await writeFile(lock, marker);
  const locked = await check(['--startup'], freeEnv);
  assert.equal(locked.status, 1);
  assert.match(locked.stdout, /工作区已锁定/);
  assert.deepEqual(await readdir(join(root, '.data')), ['.service.lock']);
});
