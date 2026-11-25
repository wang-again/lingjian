import test from 'node:test';
import assert from 'node:assert/strict';
import { initBackupUI } from '../public/backup-ui.js';

test('导入完成替换弹窗后不再查询已移除的控件；关闭预览不影响导入完成', async t => {
  const previousDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  for (const closeDuringApply of [false, true]) {
    const nodes = new Map(), dialogs = [], get = id => nodes.get(id) || null;
    const node = id => { const value = { isConnected: true, disabled: false, textContent: '', value: 'copy' }; nodes.set(id, value); return value; };
    for (const id of ['recover-drafts', 'show-recovery', 'import-backup', 'backup-file', 'backup-workspace', 'download-recovery']) node(id);
    globalThis.document = { getElementById: get };
    let complete;
    const applying = new Promise(resolve => { complete = resolve; });
    let updated = false;
    const showModal = (label, html) => {
      dialogs.push(html);
      for (const [id, value] of nodes) if (['backup-mode', 'backup-status', 'backup-apply', 'backup-preview'].includes(id)) { value.isConnected = false; nodes.delete(id); }
      if (html.includes('id="backup-mode"')) for (const id of ['backup-mode', 'backup-status', 'backup-apply', 'backup-preview']) node(id);
    };
    initBackupUI({
      state: { user: null, documents: [], busy: false },
      api: async path => path.endsWith('/preview') ? { planId: 'plan', added: 1, replaced: 0, skipped: 0, documents: [] } : applying,
      flushSave: async () => {}, showModal, toast() {}, download() {}, recovery: { list: () => [] },
      refreshDocuments: async () => { updated = true; }
    });
    await get('backup-file').onchange({ target: { files: [{ size: 100, text: async () => '{}' }] } });
    const save = get('backup-apply').onclick();
    await new Promise(resolve => setImmediate(resolve));
    if (closeDuringApply) showModal('other', '<h2>其他窗口</h2>');
    complete({ imported: 1, snapshotId: 'snapshot', documents: [] });
    await assert.doesNotReject(save);
    assert.equal(updated, true);
    assert.match(dialogs.at(-1), closeDuringApply ? /其他窗口/ : /下载导入前文档备份/);
  }
});
