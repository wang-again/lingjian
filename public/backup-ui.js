import { t, uiHtml } from './i18n.js';
import { escapeHtml as e } from './editor.js';
import { backupFileLimit, backupVolumeTarget } from './backup-format.js';

export const documentBackup = documents => ({ product: 'lingjian', version: 1, exportedAt: new Date().toISOString(), documents: documents.map(d => ({ id: d.id, title: d.title, html: d.html, sources: d.sources, templateId: d.templateId, history: d.history || [], createdAt: d.createdAt, updatedAt: d.updatedAt })) });

export function backupVolumes(documents) {
  const backup = documentBackup(documents);
  if (!backup.documents.length) throw new Error(t('当前没有文档可备份。'));
  const { documents: entries, ...metadata } = backup;
  const header = `${JSON.stringify(metadata).slice(0, -1)},"documents":[`;
  const footer = ']}';
  const overhead = new Blob([header, footer]).size;
  const volumes = [];
  let parts = [], size = overhead;
  function finish() {
    volumes.push(new Blob([header, ...parts, footer], { type: 'application/json' }));
    parts = []; size = overhead;
  }
  for (const entry of entries) {
    const blob = new Blob([JSON.stringify(entry)]);
    if (blob.size + overhead > backupFileLimit) throw new Error(t`「${entry.title}」超出单份备份上限。可使用完整工作区备份保留数据。`);
    if (parts.length && size + 1 + blob.size > backupVolumeTarget) finish();
    if (parts.length) { parts.push(','); size++; }
    parts.push(blob); size += blob.size;
  }
  finish();
  return volumes;
}

export function initBackupUI({ api, state, flushSave, showModal, toast, download, recovery, refreshDocuments }) {
  const $ = id => document.getElementById(id);
  const owner = () => state.user?.id || 'local';
  function backupDownload(documents, label = '灵笺文档备份') {
    const volumes = backupVolumes(documents);
    const filename = `${label}_${new Date().toISOString().slice(0, 10)}`;
    if (volumes.length === 1) { download(volumes[0], `${filename}.json`); return; }
    showModal(t('文档备份'), uiHtml`<h2>下载备份分卷</h2><p class="modal-description">全部下载后，按顺序逐卷导入。每份文档的正文、资料和历史保存在同一卷。</p><div class="backup-preview">${volumes.map((volume, index) => uiHtml`<article><button class="secondary" data-backup-volume="${index}">下载第 ${index + 1} / ${volumes.length} 卷</button><small>${(volume.size / 1_000_000).toFixed(1)} MB</small></article>`).join('')}</div>`);
    $('modal-body').querySelectorAll('[data-backup-volume]').forEach(button => {
      const index = Number(button.dataset.backupVolume);
      button.onclick = () => download(volumes[index], `${filename}_${index + 1}of${volumes.length}.json`);
    });
  }
  function updateCount() {
    const count = recovery.list(owner()).length;
    $('recover-drafts').textContent = count ? t`恢复草稿（${count}）` : t('恢复草稿');
  }
  async function preview(backup, draft = null) {
    if (state.busy) throw new Error(t('请先停止当前任务，再导入备份。'));
    if (!draft) await flushSave();
    showModal(t('备份导入'), uiHtml('<h2>导入前预览</h2><p class="modal-description">包含文档、参考资料和历史版本，不包含模型配置、密钥和文件库。默认导入为新副本；同 ID 文档也可选择跳过或替换。执行前会保存当前全部文档的恢复快照。</p><label class="modal-label">同 ID 文档处理<select id="backup-mode"><option value="copy">导入为副本（推荐）</option><option value="skip">跳过同 ID 文档</option><option value="replace">替换同 ID 文档</option></select></label><p id="backup-status" role="status"></p><div id="backup-preview" class="backup-preview"></div><button id="backup-apply" class="primary" disabled>确认导入</button>'));
    let plan, version = 0;
    const button = $('backup-apply'), mode = $('backup-mode'), status = $('backup-status'), list = $('backup-preview');
    async function load() {
      const request = ++version; plan = null; button.disabled = true;
      status.textContent = t('正在校验备份…');
      try {
        const result = await api('/api/backups/preview', { method: 'POST', body: { backup, mode: mode.value } });
        if (request !== version || !button.isConnected) return;
        plan = result;
        status.textContent = t`新增 ${result.added} 篇，替换 ${result.replaced} 篇，跳过 ${result.skipped} 篇。预览有效期 15 分钟。`;
        const action = { add: t('新增文档'), copy: t('新副本'), skip: t('跳过'), replace: t('替换现有文档') };
        list.innerHTML = result.documents.map(d => uiHtml`<article><strong>${e(d.title)}</strong><p>${action[d.action]} · ${d.sources} 份资料 · ${d.history} 个历史版本</p><small>${e(d.excerpt)}</small></article>`).join('');
        button.disabled = result.added + result.replaced === 0;
      } catch (error) { if (request === version) status.textContent = error.message; }
    }
    mode.onchange = load;
    button.onclick = async () => {
      if (!plan) return;
      button.disabled = true; mode.disabled = true;
      try {
        if (state.busy) throw new Error(t('请先停止当前任务。'));
        if (!draft) await flushSave();
        const ownerAtApply = owner();
        const result = await api('/api/backups/apply', { method: 'POST', body: { planId: plan.planId } });
        if (draft) recovery.discard(ownerAtApply, draft);
        if (state.token === '' || owner() !== ownerAtApply) return;
        await refreshDocuments(result.documents, draft?.document);
        updateCount();
        if (button.isConnected) {
          showModal(t('备份导入'), uiHtml`<h2>导入完成</h2><p>已导入 ${result.imported} 篇文档。可在左侧文档列表打开。</p>${result.snapshotId ? uiHtml('<p class="modal-description">导入前的文档已备份。如需恢复，可下载后通过「导入文档备份」重新导入。</p><button id="download-restore-point" class="secondary">下载导入前文档备份</button>') : ''}`);
          const snapshot = $('download-restore-point');
          if (snapshot) snapshot.onclick = async () => {
            snapshot.disabled = true;
            try {
              const backup = await api(`/api/backups/snapshots/${encodeURIComponent(result.snapshotId)}`);
              if (snapshot.isConnected && state.token && owner() === ownerAtApply) backupDownload(backup.documents, '灵笺导入前备份');
            } catch (error) { toast(error.message, true); }
            finally { snapshot.disabled = false; }
          };
        }
        toast(result.snapshotId ? t`已导入 ${result.imported} 篇文档，恢复前快照已保留。` : t`已导入 ${result.imported} 篇文档。`);
      } catch (error) { status.textContent = t`${error.message} 可重试本次导入；文档发生变化时请重新预览。`; button.disabled = false; }
      finally { mode.disabled = false; }
    };
    await load();
  }
  function drafts() {
    const user = owner(), entries = recovery.list(user);
    showModal(t('异常恢复'), uiHtml`<h2>恢复草稿</h2><p class="modal-description">这些内容保存在当前浏览器，按工作区区分，可能包含断开前或保存结果未确认的修改。恢复时会先预览，默认新增副本。可先下载后再处理。</p><div class="backup-preview">${entries.map((item, index) => uiHtml`<article><strong>${e(item.document.title)}</strong><p>${e(new Date(item.savedAt).toLocaleString())}</p><small>${e(item.document.html.replace(/<[^>]*>/g, '').slice(0, 180))}</small><div class="modal-choice"><button class="secondary" data-draft-preview="${index}">预览并恢复</button><button class="secondary" data-draft-download="${index}">下载草稿</button><button class="text-button" data-draft-discard="${index}">丢弃</button></div></article>`).join('') || uiHtml('<p>当前工作区没有待恢复草稿。</p>')}</div>`);
    document.querySelectorAll('[data-draft-preview]').forEach(button => { button.onclick = () => {
      const item = entries[Number(button.dataset.draftPreview)];
      preview(documentBackup([item.document]), item).catch(error => toast(error.message, true));
    }; });
    document.querySelectorAll('[data-draft-download]').forEach(button => { button.onclick = () => backupDownload([entries[Number(button.dataset.draftDownload)].document], '灵笺恢复草稿'); });
    document.querySelectorAll('[data-draft-discard]').forEach(button => { button.onclick = () => {
      const item = entries[Number(button.dataset.draftDiscard)];
      if (window.confirm(t`丢弃「${item.document.title}」的恢复草稿？此操作无法撤回。`)) {
        if (!recovery.discard(user, item)) toast(t('草稿已变化或无法清除，请查看最新内容。'), true);
        updateCount(); drafts();
      }
    }; });
  }
  $('import-backup').onclick = () => $('backup-file').click();
  $('backup-file').onchange = async event => {
    try {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > backupFileLimit) throw new Error(t('每份文档备份需小于 130 MB。请选择分卷备份。'));
      let backup; try { backup = JSON.parse(await file.text()); } catch { throw new Error(t('备份不是有效的 JSON 文件。')); }
      await preview(backup);
    } catch (error) { toast(error.message, true); }
    finally { event.target.value = ''; }
  };
  $('backup-workspace').onclick = async () => { try { await flushSave(); backupDownload(state.documents); } catch (error) { toast(error.message, true); } };
  $('recover-drafts').onclick = drafts;
  $('show-recovery').onclick = drafts;
  $('download-recovery').onclick = () => { if (state.doc) backupDownload([state.doc], '灵笺恢复草稿'); };
  updateCount();
  return { updateCount, drafts };
}
