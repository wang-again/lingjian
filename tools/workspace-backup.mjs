import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDataLock } from '../lib/data-lock.mjs';
import { projectRoot } from '../lib/runtime.mjs';

// history 存放正文历史快照（单机模式在数据根目录，账号模式在 users/<id>/ 下），必须一并备份。
const dataEntries = new Set(['accounts.json', 'workspace.json', 'workspace.json.v1.bak', 'keys.json', 'history', 'users', 'office', 'restore-points']);

function contains(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('请选择实际目录，不能使用符号链接或目录联接。');
  return realpath(path);
}

async function destination(source, path) {
  const absolute = resolve(path);
  const parent = await realpath(dirname(absolute));
  const target = join(parent, relative(dirname(absolute), absolute));
  if (contains(source, target) || contains(target, source)) throw new Error('目标目录不能与源目录重叠。');
  try {
    await lstat(target);
    throw new Error('目标目录已存在。请选择新目录，避免覆盖现有数据。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function inventory(root, { excludeTransient = false } = {}) {
  const files = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      if (excludeTransient && ((dir === root && !dataEntries.has(name)) || name === '_scratch' || name.endsWith('.tmp'))) continue;
      const path = join(dir, name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('备份目录含符号链接或目录联接，已停止。');
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) files.push({ path: relative(root, path).split(sep).join('/'), bytes: info.size, sha256: await digest(path) });
      else throw new Error('备份只接受普通文件。');
    }
  }
  await walk(root);
  return files;
}

function summary(files) {
  return {
    accounts: files.some(file => file.path === 'accounts.json'),
    workspaces: files.filter(file => /^(?:users\/[^/]+\/)?workspace\.json$/.test(file.path)).length,
    officeFiles: files.filter(file => /^(?:users\/[^/]+\/)?office\/files\//.test(file.path)).length,
    encryptedKeys: files.filter(file => /^(?:users\/[^/]+\/)?keys\.json$/.test(file.path)).length,
    restorePoints: files.filter(file => /^(?:users\/[^/]+\/)?restore-points\//.test(file.path)).length,
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0)
  };
}

async function copyVerified(source, target, files) {
  await mkdir(target);
  try {
    for (const file of files) {
      const output = join(target, file.path);
      await mkdir(dirname(output), { recursive: true });
      await copyFile(join(source, file.path), output, constants.COPYFILE_EXCL);
      if (await digest(output) !== file.sha256) throw new Error(`文件校验失败：${file.path}`);
    }
  } catch (error) {
    throw new Error(`复制未完成，暂勿使用目标目录。原因：${error.message}`);
  }
}

export async function createWorkspaceBackup(dataDir, backupDir) {
  const source = await directory(resolve(dataDir)), target = await destination(source, backupDir);
  const release = await acquireDataLock(source);
  try {
    const files = await inventory(source, { excludeTransient: true });
    if (!files.length) throw new Error('数据目录没有可备份的文件。');
    await mkdir(target);
    await copyVerified(source, join(target, 'data'), files);
    await writeFile(join(target, 'manifest.json'), JSON.stringify({ version: 1, type: 'lingjian-workspace', createdAt: new Date().toISOString(), files }, null, 2), { flag: 'wx', mode: 0o600 });
    return { target, ...summary(files) };
  } finally {
    await release();
  }
}

export async function restoreWorkspaceBackup(backupDir, dataDir, { apply = false } = {}) {
  const root = await directory(resolve(backupDir)), target = await destination(root, dataDir);
  const source = await directory(join(root, 'data'));
  const manifestPath = join(root, 'manifest.json');
  if (!(await lstat(manifestPath)).isFile()) throw new Error('备份清单必须是普通文件。');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.version !== 1 || manifest.type !== 'lingjian-workspace' || !Array.isArray(manifest.files)) throw new Error('备份清单格式不正确。');
  const files = await inventory(source);
  const expected = new Map(manifest.files.map(file => [file.path, file]));
  if (!files.length || expected.size !== manifest.files.length || files.length !== expected.size || files.some(file => {
    const entry = expected.get(file.path);
    return !dataEntries.has(file.path.split('/')[0]) || !entry || entry.bytes !== file.bytes || entry.sha256 !== file.sha256;
  })) throw new Error('备份文件不完整或校验失败，恢复已停止。');
  if (apply) await copyVerified(source, target, files);
  return { target, ...summary(files) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [action, first, second, flag, ...extra] = process.argv.slice(2);
    let result;
    if (action === 'create' && first && !flag) {
      result = await createWorkspaceBackup(second || join(projectRoot, '.data'), first);
    } else if (action === 'restore' && first && second && (!flag || flag === '--apply') && !extra.length) {
      result = await restoreWorkspaceBackup(first, second, { apply: flag === '--apply' });
    } else {
      throw new Error('用法：create <备份目录> [源数据目录] 或 restore <备份目录> <新数据目录> [--apply]');
    }
    console.log(action === 'create' ? '备份已创建' : flag ? '恢复已完成' : '恢复预览。确认后添加 --apply 执行。');
    console.log(`目标：${result.target}\n工作区：${result.workspaces} · 文件库：${result.officeFiles} · 恢复快照：${result.restorePoints}\n账号数据：${result.accounts ? '有' : '无'} · 加密密钥文件：${result.encryptedKeys}\n共 ${result.files} 个文件，${result.bytes} 字节`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
