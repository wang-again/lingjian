import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { UserError } from './providers.mjs';
import { backupRequestLimit } from '../public/backup-format.js';
import { restoreAnnotations } from './annotations.mjs';

export const backupLimit = backupRequestLimit;
// 预览计划暂存在磁盘上：把整份备份留在内存会让 200 篇大文档的导入常驻 GB 级。
const PLAN_TOTAL_BYTES = 300_000_000;
const PLAN_LIMIT = 20;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(v);
const text = (v, max, name) => {
  if (typeof v !== 'string' || v.length > max) throw new UserError(`备份中的${name}无效或超过长度限制。`);
  return v;
};
const date = (v, name) => {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new UserError(`备份中的${name}无效。`);
  return new Date(v).toISOString();
};
export function validateBackup(input, validateDocument) {
  if (!object(input) || input.product !== 'lingjian' || input.version !== 1 || !Array.isArray(input.documents) || !input.documents.length || input.documents.length > 200) throw new UserError('请选择灵笺版本 1 的文档备份，包含 1–200 篇文档。');
  const ids = new Set();
  return input.documents.map((item, index) => {
    try {
      if (!object(item) || !id(item.id) || ids.has(item.id)) throw new UserError('文档 ID 无效或重复。');
      ids.add(item.id);
      if (!Array.isArray(item.history) || item.history.length > 20) throw new UserError('历史版本必须为数组且不超过 20 项。');
      const historyIds = new Set();
      const history = item.history.map(h => {
        if (!object(h) || !id(h.id) || historyIds.has(h.id)) throw new UserError('历史版本 ID 无效或重复。');
        historyIds.add(h.id);
        return { id: h.id, title: text(h.title, 200, '历史标题'), html: text(h.html, 1_000_000, '历史正文'), label: text(h.label, 80, '历史说明'), at: date(h.at, '历史时间') };
      });
      // Whitelist fields: never restore model credentials, runtime flags or AI checkpoints.
      const doc = validateDocument({ title: item.title, html: item.html, sources: item.sources, templateId: item.templateId, brief: item.brief });
      return { ...doc, id: item.id, history, annotations: restoreAnnotations(item.annotations), createdAt: date(item.createdAt, '创建时间'), updatedAt: date(item.updatedAt, '修改时间'), aiEdit: null };
    } catch (error) { throw new UserError(`第 ${index + 1} 篇文档：${error.message}`); }
  });
}
// 只对「文档 ID + 版本号 + 修改时间」做指纹：正文、标题、资料或历史变化都会让 revision 递增，
// 因此不需要把几十兆正文重新 stringify 一遍就能发现预览后的修改。
const fingerprint = docs => createHash('sha256').update(JSON.stringify(docs.map(d => [d.id, d.revision, d.updatedAt]))).digest('hex');
export const documentBackup = documents => ({ product: 'lingjian', version: 1, exportedAt: new Date().toISOString(), documents });

export function createBackupManager(store, validateDocument, { now = Date.now } = {}) {
  const plans = new Map();
  const planDirectory = join(dirname(store.file), 'imports');
  const planFile = planId => join(planDirectory, `${planId}.json`);
  // 进程重启后内存里的计划已经失效，遗留的计划文件不该长期占盘。
  (async () => {
    try {
      for (const name of await readdir(planDirectory)) {
        if (!name.endsWith('.json')) continue;
        const info = await stat(join(planDirectory, name));
        if (Date.now() - info.mtimeMs > 3_600_000) await rm(join(planDirectory, name), { force: true });
      }
    } catch {}
  })();
  async function discard(plan) {
    plans.delete(plan.id);
    await rm(plan.file, { force: true }).catch(() => {});
  }
  async function sweep() {
    for (const plan of [...plans.values()]) if (now() >= plan.expiresAt) await discard(plan);
  }
  function get(planId, owner) {
    const plan = plans.get(planId);
    if (!plan || plan.owner !== owner || now() >= plan.expiresAt) throw new UserError('导入预览已失效，请重新选择备份并预览。', 409);
    return plan;
  }
  async function preview(backup, mode, owner) {
    if (!['copy', 'skip', 'replace'].includes(mode)) throw new UserError('请选择有效的冲突处理方式。');
    const docs = validateBackup(backup, validateDocument), current = store.state.documents;
    const existing = new Map(current.map(d => [d.id, d]));
    const entries = docs.map(doc => ({ doc, action: existing.has(doc.id) ? mode : 'add' }));
    const added = entries.filter(e => ['add', 'copy'].includes(e.action)).length;
    if (current.length + added > 200) throw new UserError('导入后将超过 200 篇文档上限，请减少备份内容或选择跳过/替换冲突。');
    await sweep();
    const payload = JSON.stringify(docs);
    const bytes = Buffer.byteLength(payload), held = [...plans.values()].reduce((sum, plan) => sum + plan.bytes, 0);
    if (plans.size >= PLAN_LIMIT) throw new UserError('导入预览过多，请等待旧预览到期后重试。', 429);
    if (held + bytes > PLAN_TOTAL_BYTES) throw new UserError('待应用的导入内容过多，请先应用或等待旧预览到期。', 429);
    const planId = randomUUID(), expiresAt = now() + 15 * 60_000;
    await mkdir(planDirectory, { recursive: true });
    // 先写临时文件再改名，避免预览到一半时留下半份计划。
    const file = planFile(planId), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
    plans.set(planId, { id: planId, owner, entries: entries.map(({ doc, action }) => ({ id: doc.id, action })), fingerprint: fingerprint(current), expiresAt, file, bytes });
    return { planId, expiresAt, added, replaced: entries.filter(e => e.action === 'replace').length, skipped: entries.filter(e => e.action === 'skip').length,
      documents: entries.map(({ doc, action }) => ({ id: doc.id, title: doc.title, action, sources: doc.sources.length, history: doc.history.length, characters: doc.html.length, excerpt: doc.html.replace(/<[^>]*>/g, '').slice(0, 240) })) };
  }
  async function readPlanDocuments(plan) {
    try { return JSON.parse(await readFile(plan.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new UserError('导入预览已失效，请重新选择备份并预览。', 409);
      throw new UserError('导入预览内容无法读取，请重新选择备份并预览。', 409);
    }
  }
  async function apply(planId, owner) {
    await sweep();
    const plan = get(planId, owner);
    if (plan.result) return { ...plan.result, documents: store.state.documents };
    if (plan.running) return plan.running;
    plan.running = (async () => {
      const docs = await readPlanDocuments(plan), byId = new Map(docs.map(doc => [doc.id, doc]));
      let snapshotId;
      const documents = await store.updateDocuments(async current => {
        if (fingerprint(current) !== plan.fingerprint) throw new UserError('预览后文档已发生变化，请重新预览，避免覆盖新修改。', 409);
        const changed = plan.entries.filter(e => e.action !== 'skip').map(e => ({ doc: byId.get(e.id), action: e.action })).filter(e => e.doc);
        if (!changed.length) return current;
        if (current.length) {
          snapshotId = randomUUID();
          const directory = join(dirname(store.file), 'restore-points');
          await mkdir(directory, { recursive: true });
          const target = join(directory, `${snapshotId}.json`), temporary = `${target}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify(documentBackup(current)), { mode: 0o600 });
            await rename(temporary, target);
          } finally { await rm(temporary, { force: true }).catch(() => {}); }
        }
        const result = [...current];
        for (const { doc, action } of changed) {
          const index = result.findIndex(d => d.id === doc.id);
          if (action === 'replace') {
            const previous = result[index];
            const before = { id: randomUUID(), title: previous.title, html: previous.html, at: new Date().toISOString(), label: '备份恢复前' };
            result[index] = { ...doc, revision: previous.revision + 1, history: [before, ...doc.history].slice(0, 20), updatedAt: new Date().toISOString() };
          } else result.unshift({ ...doc, id: action === 'copy' ? randomUUID() : doc.id, revision: 1, title: action === 'copy' ? `${doc.title.slice(0, 193)}（恢复副本）` : doc.title });
        }
        return result;
      });
      plan.result = { snapshotId, imported: plan.entries.filter(e => e.action !== 'skip').length };
      plan.entries = [];
      // 计划文件用完即删；内存里保留结果，重复点击「应用」仍返回同一批文档。
      await rm(plan.file, { force: true }).catch(() => {});
      return { ...plan.result, documents };
    })().finally(() => { plan.running = null; });
    return plan.running;
  }
  async function snapshot(snapshotId) {
    if (typeof snapshotId !== 'string' || !/^[a-f0-9-]{36}$/.test(snapshotId)) throw new UserError('恢复快照不存在。', 404);
    try { return await readFile(join(dirname(store.file), 'restore-points', `${snapshotId}.json`)); }
    catch (error) { if (error.code === 'ENOENT') throw new UserError('恢复快照不存在。', 404); throw error; }
  }
  return { preview, apply, snapshot };
}
