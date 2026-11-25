import { execFile } from 'node:child_process';
import { lstat, mkdir, open, unlink, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { configuredPort, loadProjectEnv, officePython, officeSetupMessage, officeToolInstalled, projectRoot } from '../lib/runtime.mjs';

const exec = promisify(execFile);
const startup = process.argv.includes('--startup');
const dataDir = join(projectRoot, '.data');
const remediation = '请运行「安装Office依赖.cmd」，或在 .env 中将 OFFICE_PYTHON 指向正确的解释器。';

async function checkData() {
  await mkdir(dataDir, { recursive: true });
  const lock = join(dataDir, '.service.lock');
  const locked = await lstat(lock).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (locked) throw new Error('工作区已锁定。请先关闭正在运行的工作台或迁移工具。若上次异常退出，请确认原进程已结束后再删除 .data/.service.lock。');
  const probe = join(dataDir, `.doctor-${crypto.randomUUID()}.tmp`);
  const file = await open(probe, 'wx', 0o600);
  try {
    await file.writeFile('write check');
  } finally {
    await file.close();
    await unlink(probe);
  }
  return `${dataDir} 可写，未发现运行锁`;
}

async function checkPort(host, port) {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return `${host}:${port} 可用`;
}

const pythonOptions = {
  cwd: projectRoot,
  env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
  windowsHide: true,
  timeout: 15_000
};

async function checkPython(python) {
  const { stdout } = await exec(python, ['--version'], pythonOptions);
  const match = /^Python (\d+)\.(\d+)\.\d+/.exec(stdout.trim());
  if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
    throw new Error('Office 需要 Python 3.10 或更高版本。');
  }
  return stdout.trim();
}

async function checkImports(python, source) {
  try {
    await exec(python, ['-c', source], pythonOptions);
  } catch (error) {
    if (error.killed) throw new Error('依赖检查超时。');
    const detail = /(?:ModuleNotFoundError|ImportError): ([^\r\n]+)/.exec(error.stderr || '');
    throw new Error(detail ? detail[1] : '依赖未能加载。');
  }
  return '依赖可加载';
}

async function checkLockedVersions(python) {
  const file = join(projectRoot, 'requirements-office.lock');
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return '未找到 requirements-office.lock，跳过版本比对'; throw error; }
  const pins = raw.split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z0-9_.-]+==\S+$/.test(line)).map(line => line.split('=='));
  if (!pins.length) return '锁定文件没有可解析的版本行，跳过比对';
  const script = 'import json,importlib.metadata as m,sys;print(json.dumps({n:m.version(n) for n in sys.argv[1:]}))';
  const { stdout } = await exec(python, ['-c', script, ...pins.map(([name]) => name)], pythonOptions);
  const installed = JSON.parse(stdout);
  const mismatches = pins.filter(([name, version]) => installed[name] !== version).map(([name, version]) => `${name} 已装 ${installed[name] || '缺失'}，锁定 ${version}`);
  if (mismatches.length) throw new Error(`与 requirements-office.lock 不一致：${mismatches.join('；')}`);
  return `${pins.length} 个顶层依赖与锁定版本一致`;
}

async function report(label, task, advice, optional = false) {
  try {
    console.log(`[通过] ${label} · ${await task()}`);
    return true;
  } catch (error) {
    console.log(`[${optional && startup ? '警告' : '失败'}] ${label} · ${advice(error)}`);
    if (!optional || !startup) process.exitCode = 1;
    return false;
  }
}

async function main() {
  console.log('灵笺 · 本地环境自检');
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error(`[失败] Node.js · 当前为 ${process.version}，请安装 Node.js 22 或更高版本。`);
    process.exitCode = 1;
    return;
  }
  console.log(`[通过] Node.js · ${process.version}`);
  let port, host;
  if (!await report('启动配置', () => {
    loadProjectEnv();
    port = configuredPort();
    host = process.env.HOST || '127.0.0.1';
    return '已读取当前启动设置';
  }, error => error.code ? '无法读取项目的 .env。请检查文件路径与读取权限。' : error.message)) return;

  const checks = await Promise.all([
    report('数据目录', checkData, error => error.code ? `无法写入数据目录（${error.code}）。请确认项目位于当前用户可写的位置，且磁盘有可用空间。` : error.message),
    report('端口', () => checkPort(host, port), error => error.code === 'EADDRINUSE'
      ? `${port} 已被占用。若工作台已启动，可直接访问正在运行的实例，或修改 PORT。`
      : `无法监听 ${host}:${port}（${error.code || '未知错误'}）。请检查 HOST、PORT 和本机权限。`)
  ]);
  if (startup && checks.includes(false)) return;

  if (!await officeToolInstalled()) {
    console.log(`[跳过] Office 工具 · ${officeSetupMessage}`);
    return;
  }
  const python = officePython();
  if (!await report('Office Python', () => checkPython(python), error => error.code || error.killed ? `无法运行配置的 Python。 ${remediation}` : `${error.message} ${remediation}`, true)) return;
  await Promise.all([
    report('Word / Excel / PPT / PDF', () => checkImports(python, 'import docx, openpyxl, pptx, pymupdf, PIL, numpy; from mcp.server.fastmcp import FastMCP'), error => `${error.message} ${remediation}`, true),
    report('OCR', () => checkImports(python, 'import rapidocr, onnxruntime'), error => `${error.message} ${remediation}`, true),
    report('依赖版本', () => checkLockedVersions(python), error => `${error.message}。请按锁定版本重装，或更新 requirements-office.lock。`, true)
  ]);
}

await main();
