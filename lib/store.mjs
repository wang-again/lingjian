import { mkdir, readFile, writeFile, rename, rm, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { initialDocument } from './templates.mjs';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);

export async function createStore(directory) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'workspace.json');
  const metaFile = join(directory, 'meta.json');
  const historyDirectory = join(directory, 'history');
  const historyFile = id => join(historyDirectory, `${id}.json`);
  let state, recovered = null;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.documents) || !Array.isArray(state.providers)) throw new Error('数据格式不正确');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // 解析失败时不再直接拒绝启动：把原文件改名隔离，用空工作区继续，启动后显式提示备份位置。
      const backup = `${file}.corrupt-${Date.now()}`;
      try { await rename(file, backup); }
      catch (renameError) { throw new Error(`工作区读取失败。请保留 ${file} 并检查文件：${error.message}（隔离失败：${renameError.message}）`); }
      recovered = { file, backup, reason: error.message };
      state = { version: 1, documents: [initialDocument()], providers: [], activeProviderId: null };
    } else {
      state = { version: 1, documents: [initialDocument()], providers: [], activeProviderId: null };
    }
  }
  let tail = Promise.resolve();

  // 历史快照单独存放：保存正文时不再重写几十兆的历史，主文件只保留当前内容。
  // 序列化时始终剔除 history，避免任何调用方把它写回主文件。
  const strip = documents => documents.map(({ history, ...document }) => document);
  async function writeJson(target, value) {
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function write(documents) {
    await writeJson(file, { ...state, documents: strip(documents) });
    // 管理端只需要「多少篇文档 / 多少套模型」。没有这份小文件时，每翻一页都要
    // 解析所有用户的整份工作区；写了之后配合大小与 mtime 校验，可跳过解析。
    const info = await stat(file);
    await writeJson(metaFile, {
      version: 1,
      documents: documents.length,
      providers: state.providers.length,
      sourceSize: info.size,
      sourceMtimeMs: Math.round(info.mtimeMs),
      updatedAt: new Date().toISOString()
    });
  }
  async function writeHistory(document) {
    if (!validId(document?.id)) return;
    await mkdir(historyDirectory, { recursive: true });
    await writeJson(historyFile(document.id), Array.isArray(document.history) ? document.history : []);
  }

  let migrated = false;
  async function loadHistory() {
    const inline = state.documents.filter(document => Array.isArray(document.history) && document.history.length);
    if (inline.length) {
      // 旧版把历史写在主文件里：先留一份原样副本，再拆到 history/ 目录。
      migrated = true;
      await mkdir(historyDirectory, { recursive: true });
      await copyFile(file, `${file}.v1.bak`).catch(() => {});
      for (const document of inline) await writeHistory(document);
      state.documents = state.documents.map(({ history, ...document }) => document);
      await write(state.documents);
    }
    state.documents = await Promise.all(state.documents.map(async document => {
      if (!validId(document.id)) return { ...document, history: [] };
      try { return { ...document, history: JSON.parse(await readFile(historyFile(document.id), 'utf8')) }; }
      catch (error) {
        if (error.code === 'ENOENT') return { ...document, history: [] };
        throw new Error(`历史快照读取失败。请保留 ${historyFile(document.id)} 并检查文件：${error.message}`);
      }
    }));
  }

  function enqueue(action) {
    const task = tail.catch(() => {}).then(action);
    tail = task;
    return task;
  }
  function persist() { return enqueue(() => write(state.documents)); }
  function updateDocuments(transform) {
    return enqueue(async () => {
      const previous = new Map(state.documents.map(document => [document.id, document]));
      const next = await transform(structuredClone(state.documents));
      for (const document of next) {
        const before = previous.get(document.id);
        // 只在历史真的变化时重写历史文件：普通自动保存会递增 revision 但不新增快照，
        // 这类保存不应触发一次与历史体积等量的写盘。
        const changed = !before
          || (before.history?.length || 0) !== (document.history?.length || 0)
          || before.history?.[0]?.id !== document.history?.[0]?.id;
        if (changed) await writeHistory(document);
      }
      const kept = new Set(next.map(document => document.id));
      for (const id of previous.keys()) if (!kept.has(id) && validId(id)) await rm(historyFile(id), { force: true });
      await write(next);
      state.documents = next;
      return next;
    });
  }

  await loadHistory();
  await persist();
  return { state, persist, updateDocuments, file, metaFile, historyDirectory, migrated, recovered };
}
