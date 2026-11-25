import { readFile, readdir, mkdir, lstat, copyFile, constants } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDataLock } from '../lib/data-lock.mjs';
import { atomicJson } from '../lib/accounts.mjs';
import { validateProvider } from '../lib/providers.mjs';

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function regularPath(path, root) {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('迁移路径超出数据目录。');
  let current = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('迁移不接受符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function mergeById(existing, incoming, label, limit) {
  const next = [...existing];
  for (const item of incoming) {
    const prior = next.find(value => value.id === item.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(item)) throw new Error(`${label}存在同 ID 的不同内容；未覆盖任何已有条目。`);
    if (!prior) next.push(item);
  }
  if (next.length > limit) throw new Error(`${label}合并后超过 ${limit} 项，请先整理。`);
  return next;
}
export async function migrateLegacy({ dataDir, username, apply = false }) {
  const root = resolve(dataDir), release = await acquireDataLock(root);
  try {
    const users = await readJson(join(root, 'accounts.json'));
    const user = users.find(item => item.username === String(username).trim().normalize('NFKC').toLowerCase());
    if (!user || !/^[a-f0-9-]{36}$/.test(user.id)) throw new Error('目标账号不存在。请先在本机注册该账号，再停止服务并执行迁移。');
    const source = await readJson(join(root, 'workspace.json'));
    if (source.version !== 1 || !Array.isArray(source.documents) || !Array.isArray(source.providers)) throw new Error('旧工作区格式无效。');
    const target = join(root, 'users', user.id), workspaceFile = join(target, 'workspace.json');
    await regularPath(workspaceFile, root);
    const existing = await readJson(workspaceFile, { version: 1, documents: [], providers: [], activeProviderId: null });
    const providers = source.providers.map(validateProvider);
    const next = { ...existing, documents: mergeById(existing.documents, source.documents, '文档', 200), providers: mergeById(existing.providers, providers, '模型配置', 30), activeProviderId: existing.activeProviderId || source.activeProviderId };
    const files = [];
    async function walk(directory, suffix = '') {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (entry.name === '_scratch' || entry.name.endsWith('.tmp') || entry.name === 'labels.json' && !suffix) continue;
        if (entry.isSymbolicLink()) throw new Error('旧文件库包含符号链接，迁移已停止。');
        const sourcePath = join(directory, entry.name), rel = join(suffix, entry.name), destination = join(target, 'office', rel);
        await regularPath(destination, root);
        if (entry.isDirectory()) await walk(sourcePath, rel);
        else if (entry.isFile()) {
          try { if (!(await readFile(destination)).equals(await readFile(sourcePath))) throw new Error('文件库存在同名的不同内容；迁移已停止。'); }
          catch (error) { if (error.code === 'ENOENT') files.push({ source: sourcePath, destination }); else throw error; }
        }
      }
    }
    await walk(join(root, 'office'));
    const oldLabels = await readJson(join(root, 'office', 'labels.json'), {}), labelsFile = join(target, 'office', 'labels.json');
    await regularPath(labelsFile, root);
    const newLabels = await readJson(labelsFile, {});
    const result = { username: user.username, documentsToAdd: next.documents.length - existing.documents.length, providersToAdd: next.providers.length - existing.providers.length, filesToCopy: files.length, applied: apply };
    if (apply) {
      for (const file of files) { await mkdir(dirname(file.destination), { recursive: true }); await copyFile(file.source, file.destination, constants.COPYFILE_EXCL); }
      await mkdir(join(target, 'office'), { recursive: true });
      await atomicJson(labelsFile, { ...oldLabels, ...newLabels });
      await atomicJson(workspaceFile, next);
    }
    return result;
  } finally { await release(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2), index = args.indexOf('--username');
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) { console.error('用法：node tools/migrate-workspace.mjs --username 用户名 [--apply]（先停止服务）'); process.exitCode = 1; }
  else migrateLegacy({ dataDir: join(dirname(fileURLToPath(import.meta.url)), '..', '.data'), username: args[index + 1], apply: args.includes('--apply') })
    .then(result => console.log(`${result.applied ? '迁移完成，旧数据仍保留。' : '仅预览，未复制数据。加 --apply 执行。'}\n${JSON.stringify(result, null, 2)}`))
    .catch(error => { console.error(`迁移失败：${error.message}`); process.exitCode = 1; });
}
