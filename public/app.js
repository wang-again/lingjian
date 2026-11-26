import { changeLanguage, language, localizePage, t, uiHtml } from './i18n.js';
import {createLiveEdit} from './live-edit.js';
import { escapeHtml as e, sanitizeHtml, markdownToHtml, docxContent, editorMarkdown } from './editor.js';
import { initOffice } from './office.js';
import { initAdmin } from './admin.js';
import { initQuality } from './quality.js';
import { initAnnotations } from './annotations.js';
import { initStudio } from './studio.js';
import { captureFragment, fragmentIsCurrent, fragmentResultHtml } from './fragments.js';
import { createRecoveryStore, sameDraftContent } from './recovery.js';
import { initBackupUI } from './backup-ui.js';

const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="/icon.svg#${name}"/></svg>`;
let narrowWorkspace;
const sidebarPreference = 'lingjian.sidebarCollapsed';
const state = { documents: [], templates: [], providers: [], providerPresets: [], doc: null, activeProviderId: null, token: '', view: 'documents', category: '全部模板', templateFormat: 'all', templateLanguage: language === 'en' ? '英文原版' : '中文', busy: false, result: null, selection: null };
let saveTimer, toastTimer, saveTail = Promise.resolve(), generationController;
const savingDocuments = new Set();
const recovery = createRecoveryStore();
let backupUI;
const recoveryOwner = () => state.user?.id || 'local';
function rememberDraft(doc, owner = recoveryOwner()) {
  const protectedDraft = recovery.save(owner, doc);
  backupUI?.updateCount();
  return protectedDraft;
}
function saveNotice(message = '') {
  $('save-recovery').hidden = !message;
  $('save-recovery-message').textContent = message;
}
let officeUI, adminUI, qualityUI, studioUI, annotationUI;
let modelListController, modelListVersion = 0;
const templateLabel = (template, value) => template.category === '我的模板' ? value : t(value);
const formatDate = value => new Intl.DateTimeFormat(language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

function toast(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3200);
}
async function api(path, { method = 'GET', body, signal, raw = false } = {}) {
  const token = state.token;
  const response = await fetch(path, { method, signal, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Workspace-Token': token }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const suffix = data.requestId ? t`（错误编号 ${data.requestId}，终端日志可查同一编号）` : '';
    const error = new Error((t(data.error) || t`本地请求失败（${response.status}）`) + suffix);
    error.diagnostic = data.diagnostic;
    error.status = response.status;
    error.code = data.code;
    error.requestId = data.requestId;
    if (response.status === 401 && token && token === state.token) lockWorkspace(true);
    throw error;
  }
  return raw ? response : response.json();
}
function showModal(eyebrow, html) {
  $('modal-eyebrow').textContent = eyebrow; $('modal-body').innerHTML = html; $('modal').showModal();
}
function currentTemplate() { return state.templates.find(item => item.id === state.doc?.templateId); }
function activeProvider() { return state.providers.find(item => item.id === state.activeProviderId); }
function updateSidebarToggle() {
  const expanded = narrowWorkspace.matches
    ? $('sidebar').classList.contains('mobile-open')
    : !$('workspace-shell').classList.contains('sidebar-collapsed');
  const button = $('sidebar-toggle');
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', expanded ? t('收起侧栏') : t('展开侧栏'));
  button.title = button.getAttribute('aria-label');
}
function closeSidebarDrawer() {
  const sidebar = $('sidebar');
  if (!sidebar.classList.contains('mobile-open')) return;
  const hadFocus = sidebar.contains(document.activeElement);
  sidebar.classList.remove('mobile-open');
  updateSidebarToggle();
  if (hadFocus) $('sidebar-toggle').focus();
}
function bindSidebar() {
  const shell = $('workspace-shell');
  const sidebar = $('sidebar');
  try { shell.classList.toggle('sidebar-collapsed', localStorage.getItem(sidebarPreference) === 'true'); } catch {}
  updateSidebarToggle();
  $('sidebar-toggle').onclick = () => {
    if (narrowWorkspace.matches) {
      if (sidebar.classList.contains('mobile-open')) closeSidebarDrawer();
      else {
        sidebar.classList.add('mobile-open');
        $('sidebar-close').focus();
      }
    } else {
      const collapsed = shell.classList.toggle('sidebar-collapsed');
      try { localStorage.setItem(sidebarPreference, String(collapsed)); } catch {}
    }
    updateSidebarToggle();
  };
  $('sidebar-close').onclick = closeSidebarDrawer;
  sidebar.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeSidebarDrawer();
  });
  narrowWorkspace.addEventListener('change', () => {
    closeSidebarDrawer();
    updateSidebarToggle();
  });
}
function setView(view) {
  if (state.busy && view !== state.view) { toast(t('请先停止当前任务，再切换页面。')); return; }
  if(view==='admin'&&state.user?.role!=='admin'){toast(t('此入口需要管理员权限。'),true);return;}
  state.view = view;
  $('desk-actions').hidden = view !== 'documents';
  $('document-menu').open = false;
  for (const name of ['documents', 'templates', 'settings', 'office', 'admin', 'manual']) $(`${name}-view`).hidden = name !== view;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('breadcrumb-current').textContent = ({ documents: t('我的文档'), templates: t('模板中心'), settings: t('模型配置'), office:t('文件处理'), admin:t('管理端'), manual:t('使用手册') })[view];
  closeSidebarDrawer();
  if (view === 'manual') { document.body.classList.add('manual-open'); $('manual-view').scrollTop = 0; }
  else document.body.classList.remove('manual-open');
  if (view === 'templates') renderTemplates();
  if (view === 'admin') return adminUI.show();
  if (view === 'office') return officeUI.show();
  if (view === 'settings') { renderProviders(); if (!$('provider-id').value && !$('provider-name').value) fillProvider(activeProvider()); }
}
function renderDocuments() {
  $('document-count').textContent = state.documents.length;
  $('document-list').innerHTML = state.documents.map(doc => uiHtml`<div class="document-row ${state.doc?.id === doc.id ? 'selected' : ''}"><button class="document-link" data-document="${e(doc.id)}" title="${e(doc.title)}">${icon('doc')}<span>${e(doc.title)}</span></button><button class="document-delete icon-button" data-delete-document="${e(doc.id)}" aria-label="删除 ${e(doc.title)}" title="删除文档">${icon('trash')}</button></div>`).join('') || uiHtml('<p class="sidebar-empty">暂无文档</p>');
}
function renderOutline() {
  const headings = [...$('editor').querySelectorAll('h1,h2,h3,h4')];
  $('outline-count').textContent = headings.length ? `${headings.length}` : '';
  $('outline-list').innerHTML = headings.map((heading, index) => `<button data-heading="${index}" class="outline-item ${['H3', 'H4'].includes(heading.tagName) ? 'nested' : ''}" title="${e(heading.textContent)}">${e(heading.textContent || t('未命名章节'))}</button>`).join('') || uiHtml('<span class="sidebar-empty">添加标题后，在这里快速定位。</span>');
}
function updateStats() {
  const content = $('editor').textContent;
  const count = content.replace(/\s/g, '').length;
  const minutes = language === 'en' ? (content.match(/\S+/g)?.length || 0) / 225 : count / 450;
  $('word-count').textContent = t`${count.toLocaleString(language)} 字`;
  $('reading-time').textContent = t`约 ${Math.max(1, Math.ceil(minutes))} 分钟阅读`;
  $('paper-title').textContent = state.doc?.title || t('未命名文档');
  renderOutline();
}
function renderCurrent() {
  $('document-title').value = state.doc?.title || '';
  $('document-title').disabled = !state.doc;
  $('editor').innerHTML = sanitizeHtml(state.doc?.html || '');
  $('editor').contentEditable = state.doc ? 'true' : 'false';
  const template = currentTemplate();
  $('template-badge').textContent = template ? t`模板 · ${template.title}` : '';
  $('template-badge').hidden = !template;
  $('save-status').textContent = t('已保存');
  clearFragment(); $('sent-fragment').hidden = true; $('selection-status').textContent = t('A4 文档 · 自由编辑');
  closeAiReport(); refreshAiControls();
  state.result = null; $('generation-result').hidden = true; $('assistant-welcome').hidden = false;
  qualityUI?.reset();
  studioUI?.reset();
  annotationUI?.close();
  renderDocuments(); updateStats(); renderSources();
}
// 服务端直接改了正文（章节调整、任务执行、项目绑定）时，把结果同步回编辑器。
// 保持 state.doc 的对象身份不变，正在排队的保存任务仍然指向同一篇文档。
function applyDocument(updated) {
  const current = state.doc;
  if (!current || !updated || current.id !== updated.id) return;
  Object.assign(current, {
    title: updated.title, html: updated.html, templateId: updated.templateId, brief: updated.brief,
    sources: updated.sources, history: updated.history, revision: updated.revision, updatedAt: updated.updatedAt,
    evidence: updated.evidence, delivery: updated.delivery, annotations: updated.annotations, tasks: updated.tasks, locks: updated.locks, projectId: updated.projectId
  });
  current._dirty = false;
  $('document-title').value = current.title;
  $('editor').innerHTML = sanitizeHtml(current.html);
  if (state.selection) clearFragment({ keepRewrite: true });
  $('save-status').textContent = t('已保存');
  updateStats(); renderDocuments(); qualityUI?.refreshIndicators(); studioUI?.refreshBadge();
  annotationUI?.refresh();
}
function dirty() {
  if (!state.doc || state.busy) return;
  if (state.selection && state.selection.html !== $('editor').innerHTML) clearFragment({ keepRewrite: true });
  state.doc.title = $('document-title').value.trim() || t('未命名文档');
  state.doc.html = sanitizeHtml($('editor').innerHTML);
  state.doc._dirty = true;
  const draftLocation = rememberDraft(state.doc);
  if (draftLocation === 'session') saveNotice(t('恢复草稿保存在此标签页，关闭标签页前请保存或下载草稿。'));
  if (!draftLocation) saveNotice(t('浏览器无法保存恢复草稿，请在离开页面前下载草稿。'));
  $('save-status').textContent = t('等待保存…');
  updateStats(); qualityUI?.markStale(); clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCurrent().catch(error => toast(error.message, true)), 650);
}
async function putDocument(doc, owner, body) {
  const path = `/api/documents/${doc.id}`;
  try {
    return await api(path, { method: 'PUT', body });
  } catch (error) {
    if (error.code !== 'WORKSPACE_TOKEN_CHANGED') throw error;
  }
  const session = await api('/api/bootstrap');
  if ((session.user?.id || 'local') !== owner) {
    lockWorkspace(true);
    throw new Error(t('当前登录账号已切换，请登录原账号查看恢复草稿。'));
  }
  if (!state.documents.includes(doc)) throw new Error(t('工作区已关闭，请重新打开后查看恢复草稿。'));
  state.token = session.token;
  return api(path, { method: 'PUT', body });
}
function saveCurrent(snapshot = null, aiEdit = null) {
  clearTimeout(saveTimer);
  const doc = state.doc, owner = recoveryOwner();
  const task = saveTail.catch(() => {}).then(async () => {
    if (!doc || !state.documents.includes(doc) || (!doc._dirty && !snapshot && !aiEdit && !doc._pendingAiEdit)) return;
    rememberDraft(doc, owner);
    if (state.doc?.id === doc.id) $('save-status').textContent = t('正在保存…');
    const edit = aiEdit || doc._pendingAiEdit;
    const body = { title: doc.title, html: doc.html, templateId: doc.templateId, brief: doc.brief || null, sources: structuredClone(doc.sources), revision: doc.revision, snapshot, ...(edit ? {aiCheckpoint: { ...edit }} : {}) };
    doc._dirty = false;
    savingDocuments.add(doc);
    try {
      const result = await putDocument(doc, owner, body);
      doc.revision = result.document.revision; doc.history = result.document.history; doc.updatedAt = result.document.updatedAt; doc.aiEdit = result.document.aiEdit;
      if (edit && doc._pendingAiEdit?.id === edit.id && doc._pendingAiEdit.status === edit.status) delete doc._pendingAiEdit;
      if (!doc._dirty) recovery.acknowledge(owner, doc);
      else rememberDraft(doc, owner);
      backupUI?.updateCount();
      refreshAiControls(false);
      if (state.doc?.id === doc.id) { $('save-status').textContent = doc._dirty ? t('等待保存…') : t('已保存'); if (!doc._dirty) saveNotice(); renderDocuments(); }
    } catch (error) {
      doc._dirty = true;
      const draftLocation = rememberDraft(doc, owner);
      if (state.doc?.id === doc.id) {
        $('save-status').textContent = t('保存失败');
        const protection = draftLocation === 'local' ? '已保留浏览器恢复草稿。' : draftLocation === 'session' ? '草稿保存在此标签页，关闭前请下载。' : '请在离开页面前下载草稿。';
        const action = error.status === 409 || error.status === 404 ? t('请通过「恢复草稿」另存为副本。') : t('可重试保存。');
        saveNotice(`${error.message} ${protection}${action}`);
      }
      throw error;
    } finally {
      savingDocuments.delete(doc);
    }
  });
  saveTail = task; return task;
}
async function flushSave() { await saveCurrent(); if (state.doc?._dirty) await saveCurrent(); }
async function selectDocument(id) {
  if (state.busy) { toast(t('请先停止当前生成任务，再切换文档。')); return; }
  await flushSave(); const doc = state.documents.find(item => item.id === id); if (!doc) return;
  state.doc = doc; try { localStorage.setItem(`lingjian.currentDocument.${state.user?.id || 'local'}`, id); } catch {}
  setView('documents'); renderCurrent(); saveNotice(); $('paper-scroll').scrollTop = 0;
}
async function createDocument(title, template = null, html = '') {
  if (state.busy) throw new Error(t('请先停止当前生成任务，再新建文档。'));
  await flushSave();
  const result = await api('/api/documents', { method: 'POST', body: { title, html: template ? markdownToHtml(template.content) : html, templateId: template?.id || null, sources: [] } });
  state.documents.unshift(result.document); await selectDocument(result.document.id);
  $('modal').close(); toast(template ? t`已使用「${template.title}」创建文档` : t('新文档已创建'));
}
function newDocumentModal() {
  showModal('', uiHtml`<h2>新建文档</h2><label class="modal-label">文档名称<input id="new-title" placeholder="未命名文档" maxlength="200"></label><div class="modal-choice"><button class="primary" id="create-blank">${icon('plus')}创建空白文档</button><button class="secondary" id="choose-template">${icon('grid')}从模板开始</button></div>`);
  $('new-title').focus();
  $('create-blank').onclick = () => createDocument($('new-title').value.trim() || t('未命名文档')).catch(error => toast(error.message, true));
  $('choose-template').onclick = () => { $('modal').close(); setView('templates'); };
  $('new-title').onkeydown = event => { if (event.key === 'Enter') $('create-blank').click(); };
}
function confirmDeleteDocument(id) {
  const doc = state.documents.find(item => item.id === id); if (!doc) return;
  showModal('DOCUMENT', uiHtml`<h2>删除这篇文档？</h2><p class="modal-description">「${e(doc.title)}」的正文、资料与历史将被删除。需要保留时，可先导出或备份。</p><div class="modal-choice"><button class="secondary" id="cancel-delete">保留文档</button><button class="danger" id="confirm-delete">删除文档</button></div>`);
  $('cancel-delete').onclick = () => $('modal').close();
  const confirm = $('confirm-delete');
  confirm.onclick = async () => {
    confirm.disabled = true;
    try {
      if (state.busy) throw new Error(t('请先停止生成任务。'));
      await flushSave();
      await api(`/api/documents/${id}`, { method: 'DELETE', body: { revision: doc.revision ?? 0 } });
      state.documents = state.documents.filter(item => item.id !== id);
      if (state.doc?.id === id) {
        state.doc = state.documents[0] || null;
        renderCurrent();
      }
      backupUI?.updateCount();
      renderDocuments(); $('modal').close(); toast(t('文档已删除'));
    } catch (error) { toast(error.message, true); }
    finally { confirm.disabled = false; }
  };
}

function renderTemplates() {
  const categories = ['全部模板', ...new Set(state.templates.map(item => item.category))];
  $('template-categories').innerHTML = categories.map(category => `<button class="${category === state.category ? 'selected' : ''}" data-category="${e(category)}">${e(t(category))}</button>`).join('');
  const query = $('template-search').value.trim().toLowerCase();
  const list = state.templates.filter(item => (state.category === '全部模板' || item.category === state.category) && (state.templateFormat === 'all' || item.assets.some(asset => asset.format === state.templateFormat)) && (state.templateLanguage === 'all' || item.language === state.templateLanguage) && `${templateLabel(item, item.title)} ${item.title} ${item.subtitle} ${item.description} ${item.source?.name || ''} ${item.assets.map(asset => asset.format).join(' ')} ${item.sections.join(' ')}`.toLowerCase().includes(query));
  $('template-result-count').textContent = t`显示 ${list.length} / ${state.templates.length} 份模板`;
  const rows = list.map(item => {
    const formats = [...new Set(item.assets.map(asset => asset.format === 'MD' ? 'Markdown' : asset.format))];
    return `<tr data-template="${e(item.id)}"><td><button type="button" class="template-name">${icon('doc')}<span>${e(templateLabel(item, item.title))}</span></button></td><td>${formats.map(e).join(' / ')}</td><td>${e(t(item.category))}</td></tr>`;
  });
  $('template-grid').innerHTML = rows.length
    ? uiHtml`<table class="directory-table"><caption class="visually-hidden">模板目录</caption><thead><tr><th scope="col">名称</th><th scope="col">格式</th><th scope="col">分类</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : uiHtml('<p class="empty-state">没有匹配的模板。可更换筛选条件或关键词。</p>');
}
function previewTemplate(id) {
  const template = state.templates.find(item => item.id === id); if (!template) return;
  const importable = new Set(['DOCX', 'XLSX', 'PDF', 'MD']);
  const assets = template.assets.map(asset => uiHtml`<div class="template-asset"><div><strong>${e(templateLabel(template, asset.label))}</strong><small>${e(asset.format)}${asset.size ? ` · ${Math.ceil(asset.size / 1024)} KB` : ''}${asset.role === 'example' ? t(' · 已填写示例') : ''}</small></div><div class="template-asset-actions"><a class="secondary compact" href="/api/templates/${encodeURIComponent(id)}/assets/${encodeURIComponent(asset.id)}" download>下载 ${e(asset.format)}</a>${importable.has(asset.format) ? `<button class="secondary compact" data-template-use-file="${e(asset.id)}">${asset.role === 'example' ? t('加入参考文件') : t('加入文件库')}</button>` : ''}</div></div>`).join('');
  const source = template.source;
  showModal(t('模板 / ') + t(template.category), uiHtml`<h2>${e(templateLabel(template, template.title))}</h2><p class="modal-description">${e(template.description)}</p><div class="template-downloads">${assets}</div>${template.assets.some(asset => ['DOC', 'XLS'].includes(asset.format)) ? uiHtml('<p class="template-use-note">旧版 DOC / XLS 可在 Word、WPS 或 Excel 中打开；如需平台 AI 填写原表，请先另存为 DOCX / XLSX 后上传。</p>') : uiHtml('<p class="template-use-note">加入文件库后，填写你的需求与数据，即可让 AI 读取模板并另存结果。PDF 可作为核对或填写参考。</p>')}<div class="template-preview-body"><div><h3>内容结构</h3><ol class="template-sections">${template.sections.map(section => `<li>${e(section)}</li>`).join('')}</ol></div><div class="template-rules"><h3>填写方法</h3><ol>${template.usage.map(item => `<li>${e(item)}</li>`).join('')}</ol></div></div><details class="template-text-preview"><summary>${source && !template.assets.some(asset => asset.format === 'MD') ? t('查看平台整理的中文提纲') : t('查看模板正文')}</summary><pre>${e(template.content)}</pre></details>${source ? uiHtml`<div class="template-source"><a href="${e(source.url)}" target="_blank" rel="noopener noreferrer">来源：${e(source.name)} ↗</a><span>${e(t(template.language))} · 核对于 ${e(source.checkedAt)}</span><a href="${e(source.licenseUrl)}" target="_blank" rel="noopener noreferrer">${e(source.license)} 许可</a><small>${e(source.attribution)}</small></div>` : ''}<button class="primary full-width" id="use-template">${e(templateLabel(template, template.editorLabel))}${icon('arrow')}</button>`);
  $('use-template').onclick = async () => {
    $('use-template').disabled = true;
    try { await createDocument(templateLabel(template, template.title), template); } catch (error) { $('use-template').disabled = false; toast(error.message, true); }
  };
  if (template.category === '我的模板') {
    const remove = document.createElement('button');
    remove.className = 'text-button template-delete';
    remove.textContent = t('删除这份模板');
    remove.onclick = () => {
      showModal('MY TEMPLATE', uiHtml`<h2>删除这份模板？</h2><p class="modal-description">「${e(template.title)}」将从模板中心移除。已创建的文档正文不会删除，只会解除模板关联。</p><div class="modal-choice"><button class="secondary" id="cancel-template-delete">保留模板</button><button class="danger" id="confirm-template-delete">删除模板</button></div>`);
      $('cancel-template-delete').onclick = () => $('modal').close();
      $('confirm-template-delete').onclick = async () => {
        const confirm = $('confirm-template-delete'); confirm.disabled = true;
        try {
          const result = await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' });
          state.templates = result.templates;
          for (const doc of state.documents) if (doc.templateId === template.id) doc.templateId = null;
          if (!state.templates.some(item => item.category === '我的模板')) state.category = '全部模板';
          $('modal').close(); renderTemplates(); renderCurrent(); toast(t('模板已删除，文档正文保留'));
        } catch (error) { confirm.disabled = false; toast(error.message, true); }
      };
    };
    $('use-template').after(remove);
  }
  document.querySelectorAll('[data-template-use-file]').forEach(button => {
    button.onclick = async () => {
      if (state.busy || officeUI.busy) return toast(t('请先完成或停止当前生成任务。'), true);
      button.disabled = true;
      try {
        const result = await api(`/api/templates/${encodeURIComponent(id)}/use`, { method: 'POST', body: { assetId: button.dataset.templateUseFile } });
        await setView('office'); officeUI.selectTemplate(result); $('modal').close(); toast(t('模板副本已加入文件库，请填写需求后执行'));
      } catch (error) { button.disabled = false; toast(error.message, true); }
    };
  });
}

function renderModelPicker() {
  $('assistant-model').innerHTML = state.providers.length ? state.providers.map(provider => `<option value="${e(provider.id)}">${e(provider.name)} · ${e(provider.model)}</option>`).join('') : uiHtml('<option value="">请先配置模型</option>');
  $('assistant-model').value = state.activeProviderId || '';
}
function renderProviders() {
  $('provider-list').innerHTML = state.providers.map(provider => uiHtml`<div class="provider-card ${provider.id === $('provider-id').value ? 'selected' : ''}"><button data-provider="${e(provider.id)}"><span class="provider-monogram">${e(provider.name.charAt(0))}</span><span><strong>${e(provider.name)}</strong><small>${e(provider.model)}</small></span>${provider.id === state.activeProviderId ? uiHtml('<span class="default-badge">使用中</span>') : ''}</button><div class="provider-card-bottom"><span>${provider.hasKey ? t('密钥可用') : t('无密钥 · 可填入或使用本地服务')}</span><button class="icon-button" data-delete-provider="${e(provider.id)}" aria-label="删除配置 ${e(provider.name)}">${icon('trash')}</button></div></div>`).join('') || uiHtml('<div class="provider-empty"><span>＋</span><strong>添加第一个模型</strong><p>填写服务地址和模型名称后保存。</p></div>');
}
function updateProviderPreset() {
  modelListController?.abort(); modelListController = null; modelListVersion++;
  $('fetch-provider-models').disabled = false; $('fetch-provider-models').textContent = t('从平台获取模型');
  const preset = state.providerPresets.find(item => item.id === $('provider-vendor').value);
  renderModelChoices(preset?.models || [], preset?.modelNotes);
  $('provider-model-list-status').textContent = preset ? t`内置 ${preset.models.length} 个模型 ID。可从完整列表选择，或输入关键词查找建议。` : t('可从平台获取模型列表，也可手动填写模型 ID。');
  $('provider-preset-hint').textContent = preset?.hint || t('填写服务商的准确地址与模型 ID，支持兼容接口、中转服务及本地模型。');
  $('provider-preset-links').hidden = !preset;
  if (preset) {
    $('provider-docs').href = preset.docsUrl;
    $('provider-console').href = preset.consoleUrl;
  } else {
    $('provider-docs').removeAttribute('href');
    $('provider-console').removeAttribute('href');
  }
}
function renderModelChoices(models, notes = {}) {
  $('provider-models').innerHTML = models.map(model => `<option value="${e(model)}"></option>`).join('');
  $('provider-model-choice').innerHTML = uiHtml`<option value="">浏览全部 ${models.length} 个模型…</option>` + models.map(model => `<option value="${e(model)}">${e(model)}${notes[model] ? ` · ${e(notes[model])}` : ''}</option>`).join('');
  $('provider-model-choice').value = models.includes($('provider-model').value) ? $('provider-model').value : '';
}
async function fetchProviderModels() {
  if (!$('provider-url').reportValidity()) return;
  modelListController?.abort();
  const version = ++modelListVersion, controller = new AbortController(); modelListController = controller;
  $('fetch-provider-models').disabled = true; $('fetch-provider-models').textContent = t('正在获取…');
  $('provider-model-list-status').textContent = t('正在查询平台模型列表…');
  try {
    const result = await api('/api/providers/models', { method: 'POST', body: providerInput(), signal: controller.signal });
    if (version !== modelListVersion) return;
    const preset = state.providerPresets.find(item => item.id === $('provider-vendor').value);
    renderModelChoices(result.models, preset?.modelNotes);
    $('provider-model-list-status').textContent = t`平台返回 ${result.models.length} 个模型${result.truncated ? t('（列表较多，仅展示前 20 页）') : ''}。请选择支持对话生成的模型；可调用权限以平台为准。`;
  } catch (error) {
    if (version === modelListVersion && error.name !== 'AbortError') $('provider-model-list-status').textContent = error.message;
  } finally {
    if (version === modelListVersion) {
      modelListController = null; $('fetch-provider-models').disabled = false; $('fetch-provider-models').textContent = t('从平台获取模型');
    }
  }
}
function applyProviderPreset() {
  const preset = state.providerPresets.find(item => item.id === $('provider-vendor').value);
  // Selecting a different service starts a new config and clears the key field.
  fillProvider();
  if (preset) {
    $('provider-vendor').value = preset.id;
    $('provider-name').value = preset.name;
    $('provider-url').value = preset.baseUrl;
    $('provider-model').value = preset.models[0];
    $('provider-max-tokens').value = preset.maxTokens;
    $('provider-timeout').value = preset.timeout;
  }
  updateProviderPreset(); updateEndpoint();
}
function fillProvider(provider = null) {
  $('provider-form').reset(); $('provider-id').value = provider?.id || '';
  $('provider-vendor').value = provider?.vendor || 'custom'; updateProviderPreset();
  $('provider-name').value = provider?.name || ''; $('provider-protocol').value = provider?.protocol || 'chat';
  $('provider-url').value = provider?.baseUrl || ''; $('provider-model').value = provider?.model || '';
  $('provider-model-choice').value = provider?.model || '';
  if ($('provider-model-choice').selectedIndex < 0) $('provider-model-choice').value = '';
  $('provider-max-tokens').value = provider?.maxTokens || 4096; $('provider-timeout').value = provider?.timeout || 120;
  $('provider-token-field').value = provider?.tokenField || 'max_tokens'; $('provider-temperature').value = provider?.temperature ?? '';
  $('provider-stream').checked = provider?.stream !== false;
  $('provider-key').type = 'password'; $('provider-key').placeholder = provider?.hasKey ? t('已存有密钥；留空保留，输入可替换') : t('输入密钥；无密钥的本地服务可留空');
  $('key-hint').textContent = provider?.keySaved
    ? t('密钥已加密保存，可在此清除。')
    : state.user ? t('密钥默认仅在本次登录期间保留。') : t('密钥仅在本机程序的内存中保留，退出后需重新填写。');
  const canRemember = Boolean(state.user && state.canRememberKeys);
  $('remember-key-option').hidden = !canRemember;
  $('remember-key').checked = canRemember && Boolean(provider?.keySaved);
  $('remember-key').disabled = !canRemember;
  $('forget-key').hidden = !provider?.id || !(provider.hasKey || provider.keySaved);
  $('provider-form-title').textContent = provider ? t('编辑模型配置') : t('添加模型配置');
  $('connection-result').hidden = true; updateEndpoint(); renderProviders();
  if ($('connection-diagnostic')) $('connection-diagnostic').hidden = true;
}
function providerInput() {
  return { ...($('provider-id').value ? { id: $('provider-id').value } : {}), vendor: $('provider-vendor').value, name: $('provider-name').value.trim(), protocol: $('provider-protocol').value, baseUrl: $('provider-url').value.trim(), model: $('provider-model').value.trim(), apiKey: $('provider-key').value.trim(), rememberKey: $('remember-key').checked, maxTokens: Number($('provider-max-tokens').value), timeout: Number($('provider-timeout').value), temperature: $('provider-temperature').value, tokenField: $('provider-token-field').value, stream: $('provider-stream').checked };
}
function updateEndpoint() {
  const base = $('provider-url').value.trim().replace(/\/+$/, ''), protocol = $('provider-protocol').value;
  const endpoint = /\/(responses|chat\/completions)$/.test(base) ? base : base + (protocol === 'responses' ? '/responses' : '/chat/completions');
  $('endpoint-preview').textContent = base ? t`请求地址：${endpoint}` : t('填写基础地址或完整接口地址，系统将自动补全路径。');
  $('token-field-label').hidden = protocol === 'responses';
}
async function saveProvider(event) {
  event.preventDefault(); const button = $('save-provider'); button.disabled = true;
  try {
    const result = await api('/api/providers', { method: 'POST', body: providerInput() });
    const index = state.providers.findIndex(item => item.id === result.provider.id);
    if (index >= 0) state.providers[index] = result.provider; else state.providers.push(result.provider);
    state.activeProviderId = result.activeProviderId;
    fillProvider(result.provider); renderModelPicker(); toast(t('配置已保存，可以返回文档开始编写'));
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}
async function testProvider() {
  if (!$('provider-form').reportValidity()) return;
  $('test-provider').disabled = true; $('test-provider').innerHTML = uiHtml('<span class="spinner"></span>连接中…');
  $('connection-result').hidden = false; $('connection-result').className = 'connection-result'; $('connection-result').textContent = t('正在验证接口、密钥与模型，请稍候…');
  showConnectionDiagnostic();
  try {
    const result = await api('/api/providers/test', { method: 'POST', body: providerInput() });
    $('connection-result').className = 'connection-result success'; $('connection-result').textContent = t`连接成功 · ${(result.elapsed / 1000).toFixed(1)} 秒 · 模型回复：${result.preview}`;
    showConnectionDiagnostic(result.diagnostic);
  } catch (error) { $('connection-result').className = 'connection-result failure'; $('connection-result').textContent = error.message; showConnectionDiagnostic(error.diagnostic); }
  finally { $('test-provider').disabled = false; $('test-provider').innerHTML = t`${icon('link')}测试连接`; }
}
function showConnectionDiagnostic(diagnostic) {
  if (!$('connection-diagnostic')) {
    const details = document.createElement('details'); details.id = 'connection-diagnostic'; details.className = 'connection-diagnostic';
    details.innerHTML = uiHtml('<summary>查看排查信息</summary><pre id="connection-diagnostic-text"></pre><button type="button" class="secondary compact" id="copy-connection-diagnostic">复制排查信息</button>');
    $('connection-result').after(details);
    $('copy-connection-diagnostic').onclick = async () => { try { await navigator.clipboard.writeText($('connection-diagnostic-text').textContent); toast(t('已复制排查信息，不包含 API Key')); } catch { toast(t('请选中上方排查信息手动复制。'), true); } };
  }
  $('connection-diagnostic').hidden = !diagnostic;
  const labels = { endpoint: t('实际请求地址'), model: t('模型 ID'), protocol: t('接口协议'), stream: t('请求模式'), category: t('诊断分类'), upstreamStatus: t('厂商 HTTP 状态'), upstreamCode: t('厂商错误码'), requestId: t('厂商请求编号'), networkCodes: t('网络错误码') };
  $('connection-diagnostic-text').textContent = diagnostic ? Object.entries(diagnostic).filter(([key]) => labels[key]).map(([key, value]) => `${labels[key]}：${key === 'stream' ? value ? t('流式') : t('非流式') : Array.isArray(value) ? value.join(', ') : value}`).join('\n') : '';
}
function deleteProvider(id) {
  const provider = state.providers.find(item => item.id === id); if (!provider) return;
  showModal('MODEL CONFIGURATION', uiHtml`<h2>删除模型配置？</h2><p class="modal-description">将删除「${e(provider.name)}」及保存的对应密钥。</p><div class="modal-choice"><button id="cancel-provider-delete" class="secondary">保留配置</button><button id="confirm-provider-delete" class="danger">删除配置</button></div>`);
  $('cancel-provider-delete').onclick = () => $('modal').close();
  $('confirm-provider-delete').onclick = async () => {
    try { const result = await api(`/api/providers/${id}`, { method: 'DELETE' }); state.providers = state.providers.filter(item => item.id !== id); state.activeProviderId = result.activeProviderId; fillProvider(activeProvider()); renderModelPicker(); $('modal').close(); toast(t('模型配置已删除')); } catch (error) { toast(error.message, true); }
  };
}

function renderSources() {
  const sources = state.doc?.sources || [];
  $('source-count').textContent = sources.length;
  $('sources-list').innerHTML = sources.map(source => uiHtml`<div class="source-item"><label><input type="checkbox" data-source-toggle="${e(source.id)}" ${source.enabled !== false ? 'checked' : ''}>${icon('doc')}<span><strong>${e(source.name)}</strong><small>${source.text.length.toLocaleString()} 字符 · ${source.enabled !== false ? t('随任务发送') : t('已停用')}</small></span></label><button class="icon-button" data-remove-source="${e(source.id)}" aria-label="移除资料 ${e(source.name)}">${icon('close')}</button></div>`).join('') || uiHtml('<p class="sources-empty">还没有添加资料。<br>项目介绍、会议记录、数据说明都可以。</p>');
  const enabled = sources.filter(source => source.enabled !== false).length;
  $('context-label').textContent = enabled ? t`发送正文及 ${enabled} 份资料至模型` : t('发送正文至模型');
}
function updateWritingNote() {
  const notes = {
    write: '新稿将替换正文，可停止或撤回。',
    continue: '续写内容将追加到文末，可停止或撤回。',
    rewrite: '仅替换所选片段，可停止或撤回。',
    outline: '大纲将在单独的视图中打开。',
    review: '审阅意见将在单独的视图中打开。'
  };
  document.querySelector('.composer-note').textContent = notes[$('task-mode').value];
}
function switchAssistant(tab) {
  const sources = tab === 'sources'; $('writing-tab').setAttribute('aria-selected', String(!sources)); $('sources-tab').setAttribute('aria-selected', String(sources));
  $('writing-panel').hidden = sources; $('sources-panel').hidden = !sources; $('composer').hidden = sources;
}
async function readTextFile(file) {
  if (file.size > 1_200_000) throw new Error(t`「${file.name}」过大，请选择较小的文本文件。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.some(byte => byte === 0) && !(bytes[0] === 255 && bytes[1] === 254)) throw new Error(t`「${file.name}」似乎不是文本文件。`);
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('gb18030').decode(bytes); }
}
async function addSources(files) {
  if (!state.doc) return;
  const pending = [];
  for (const file of files) {
    if (!/\.(txt|md|markdown|csv|docx|pdf|xlsx|xlsm|pptx)$/i.test(file.name)) throw new Error(t('参考资料支持文本、Word、Excel、PPT 和 PDF 文件。'));
    const text = /\.(docx|pdf|xlsx|xlsm|pptx)$/i.test(file.name) ? (await officeUI.uploadAndExtract(file)).text : await readTextFile(file);
    if (text.length > 300_000) throw new Error(t`「${file.name}」超过单份 30 万字符限制。`);
    pending.push({ id: crypto.randomUUID(), name: file.name.slice(0, 200), text, enabled: true });
  }
  if (state.doc.sources.length + pending.length > 20) throw new Error(t('每篇文档最多 20 份参考资料。'));
  if ([...state.doc.sources, ...pending].reduce((sum, source) => sum + source.text.length, 0) > 500_000) throw new Error(t('资料总量不能超过 50 万字符。'));
  state.doc.sources.push(...pending); state.doc._dirty = true; await saveCurrent(); renderSources(); toast(t`已添加 ${pending.length} 份参考资料`);
}
function clearFragment({ keepRewrite = false } = {}) {
  state.selection = null;
  $('fragment-card').hidden = true; $('fragment-preview').replaceChildren();
  if ($('generation-result').hidden) $('assistant-welcome').hidden = false;
  if (!keepRewrite && $('task-mode').value === 'rewrite') $('task-mode').value = 'write';
  updateWritingNote();
  $('writing-prompt').placeholder = $('task-mode').value === 'rewrite'
    ? t('选中正文，右键选择「AI 修改选区」。')
    : t('输入写作要求');
  $('selection-status').textContent = t('A4 文档 · 自由编辑');
}
function attachSelection(fragment) {
  if (state.busy || !fragmentIsCurrent($('editor'), fragment, state.doc?.id)) return;
  state.selection = fragment; $('task-mode').value = 'rewrite';
  updateWritingNote();
  const parts = [fragment.tables && `${fragment.tables} 个表格`, fragment.images.length && `${fragment.images.length} 张图片`, `${fragment.range.toString().length} 字`].filter(Boolean);
  $('fragment-label').textContent = t`所选片段 · ${parts.join(' · ')}`;
  $('fragment-preview').innerHTML = fragment.selectedHtml;
  $('fragment-card').hidden = false;
  $('assistant-welcome').hidden = true; $('generation-result').hidden = true; state.result = null;
  $('selection-status').textContent = fragment.rich ? t('已附加片段 · 图片和表格按完整块选取') : t`已附加 ${fragment.range.toString().length} 字`;
  if ($('assistant-panel').classList.contains('collapsed')) $('focus-toggle').click();
  switchAssistant('writing');
  const prompt = $('writing-prompt');
  prompt.placeholder = t('想怎样修改这个片段？例如：精简表述、补充一列、调整图片说明……');
  prompt.focus();
}

function showBrowserEditorMenu(event, fragment, range) {
  const menu = $('editor-context-menu');
  menu.hidePopover();
  menu.showPopover();
  menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - menu.offsetHeight))}px`;
  menu.querySelector('button').focus({ preventScroll: true });
  menu.onclick = async ({ target }) => {
    const command = target.closest('button')?.dataset.editorAction;
    if (!command) return;
    menu.hidePopover();
    if (command === 'rewrite') { attachSelection(fragment); return; }
    try {
      const text = command === 'paste' ? await navigator.clipboard.readText() : null;
      const editor = $('editor');
      if (state.busy || !fragmentIsCurrent(editor, fragment, state.doc?.id)) return;
      editor.focus({ preventScroll: true });
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (command === 'paste') {
        if (text) document.execCommand('insertText', false, text);
      } else if (!document.execCommand(command)) {
        toast(t('请使用系统快捷键剪切或复制。'), true);
      }
    } catch { toast(t('请使用系统快捷键粘贴。'), true); }
  };
}

function bindEditorContextMenu(editor) {
  let rightDrag;
  let openedOnRelease = false;
  const caretAt = event => {
    const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    return caret && editor.contains(caret.offsetNode) ? caret : null;
  };
  const openMenu = async event => {
    if (state.busy || !state.doc) return;
    const selection = window.getSelection();
    const fragment = captureFragment(editor, selection, state.doc.id);
    const desktop = window.lingjianDesktop;
    if (!desktop?.showEditorMenu && !fragment) return;
    event.preventDefault();
    try {
      if (desktop?.showEditorMenu) {
        const hasSelection = selection.rangeCount > 0 && !selection.isCollapsed
          && editor.contains(selection.getRangeAt(0).commonAncestorContainer);
        if (await desktop.showEditorMenu(hasSelection, Boolean(fragment), language)) attachSelection(fragment);
      } else showBrowserEditorMenu(event, fragment, selection.getRangeAt(0).cloneRange());
    } catch (error) { toast(error.message, true); }
  };
  editor.addEventListener('pointerdown', event => {
    openedOnRelease = false;
    rightDrag = null;
    if (event.button !== 2 || state.busy || !state.doc) return;
    rightDrag = { start: caretAt(event), x: event.clientX, y: event.clientY, moved: false, deferredMenu: false };
  });
  editor.addEventListener('pointermove', event => {
    if (!rightDrag?.start || !(event.buttons & 2)) return;
    if (!rightDrag.moved && Math.hypot(event.clientX - rightDrag.x, event.clientY - rightDrag.y) < 5) return;
    const end = caretAt(event);
    if (!end) return;
    const start = rightDrag.start;
    window.getSelection().setBaseAndExtent(start.offsetNode, start.offset, end.offsetNode, end.offset);
    rightDrag.moved = true;
  });
  editor.addEventListener('pointerup', event => {
    if (event.button !== 2 || !rightDrag) return;
    openedOnRelease = rightDrag.moved || rightDrag.deferredMenu;
    rightDrag = null;
    if (openedOnRelease) openMenu(event);
  });
  editor.addEventListener('pointercancel', () => { rightDrag = null; });
  editor.addEventListener('contextmenu', event => {
    if (event.button === 2 && openedOnRelease) { event.preventDefault(); return; }
    if (event.button === 2 && rightDrag) {
      event.preventDefault();
      rightDrag.deferredMenu = true;
      return;
    }
    openMenu(event);
  });
}

async function insertImage(file) {
  if (state.busy) throw new Error(t('请先停止生成，再插入图片。'));
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10_000_000) throw new Error(t('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。'));
  const imageDocumentId = state.doc?.id;
  const bitmap = await createImageBitmap(file);
  if (state.busy || state.doc?.id !== imageDocumentId) { bitmap.close(); throw new Error(t('文档或任务已变化，请在当前任务结束后重新插入图片。')); }
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const src = canvas.toDataURL('image/webp', 0.82);
  if (src.length > 800_000 || $('editor').innerHTML.length + src.length > 950_000) throw new Error(t('文档图片总量较大，请缩小图片后重试。'));
  $('editor').focus();
  const selection = window.getSelection();
  if (!selection?.rangeCount || !$('editor').contains(selection.getRangeAt(0).commonAncestorContainer)) {
    const range = document.createRange(); range.selectNodeContents($('editor')); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
  }
  document.execCommand('insertHTML', false, `<img src="${src}" alt="${e(file.name || t('粘贴的图片'))}" draggable="false"><br>`); dirty();
}

async function* responseEvents(body) {
  const reader = body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const kind = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
        if (kind && data) yield { kind, data: JSON.parse(data) };
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
}
let busyControls = [];
function setBusy(busy) {
  if (busy) {
    busyControls = [...document.querySelectorAll('#document-title, .editor-toolbar button:not(#focus-toggle), .editor-toolbar select, #new-document, #import-document, #history-button, #export-button, #brief-button, #evidence-button, #delivery-button, #studio-button, #sources-tab, #remove-fragment, #undo-ai-edit, #backup-workspace, #logout-button')].map(node => [node,node.disabled]);
    busyControls.forEach(([node]) => { node.disabled = true; });
  } else { busyControls.forEach(([node,disabled]) => { node.disabled = disabled; }); busyControls = []; }
  $('editor').contentEditable = busy ? 'false' : 'true';
  $('editor').setAttribute('aria-busy', String(busy));
  $('editor').setAttribute('aria-readonly', String(busy));
  state.busy = busy; $('generate-button').hidden = busy; $('stop-button').hidden = !busy;
  $('undo-ai-edit').disabled = busy;
  $('task-mode').disabled = busy; $('assistant-model').disabled = busy; 
  $('writing-prompt').disabled = busy; document.body.classList.toggle('is-generating', busy);
}
function renderResult(result) {
  if (result.mode === 'rewrite' && result.selection?.rich) {
    try { return fragmentResultHtml(result.text, result.selection); } catch { /* Incomplete streamed image references remain readable until completion. */ }
  }
  return markdownToHtml(result.text);
}

function closeAiReport() {
  $('ai-report-view').hidden = true; $('paper-scroll').hidden = false;
}
function refreshAiControls(showStatus = true) {
  const edit = state.doc?.aiEdit;
  $('undo-ai-edit').hidden = !edit || !state.doc.history?.some(item => item.id === edit.historyId);
  $('undo-ai-edit').disabled = state.busy;
  if (showStatus) {
    $('ai-edit-status').hidden = !edit;
    if (edit) $('ai-edit-status').textContent = edit.status === 'complete' ? t('AI 修改已保存 · 可撤回本轮修改') : t('上次 AI 修改未完成 · 已保留保存进度，可撤回');
  }
}
function showAiReport(result) {
  if (!result.reportOpened) {
    $('ai-report-title').textContent = result.mode === 'review' ? t('全文审阅') : t('AI 大纲');
    $('ai-report-view').hidden = false; $('paper-scroll').hidden = true; result.reportOpened = true;
  }
  $('ai-report-content').innerHTML = renderResult(result);
}
async function generate() {
  if (state.busy) return;
  if (!state.doc) { toast(t('请先新建或导入文档。')); return; }
  if (!activeProvider()) { setView('settings'); fillProvider(); toast(t('先配置模型，再开始编写')); return; }
  const prompt = $('writing-prompt').value.trim(), mode = $('task-mode').value, selection = state.selection;
  if (mode === 'rewrite' && !fragmentIsCurrent($('editor'), selection, state.doc.id)) { toast(t('请先选中正文，右键选择「AI 修改选区」。'), true); return; }
  if (!prompt) { $('writing-prompt').focus(); toast(t('请输入写作或修改要求。')); return; }
  setBusy(true); switchAssistant('writing'); closeAiReport();
  const result = {text:'', mode, selection, documentId:state.doc.id, complete:false, editId:crypto.randomUUID(), direct:['write','rewrite','continue'].includes(mode)};
  const doc = state.doc;
  const live = result.direct ? createLiveEdit($('editor'), {mode,selection,documentId:doc.id}) : null;
  state.result = result; generationController = new AbortController();
  $('assistant-welcome').hidden = true; $('generation-result').hidden = false;
  $('fragment-card').hidden = true; $('sent-fragment').hidden = true;
  $('result-content').innerHTML = uiHtml('<span class="thinking"><span class="spinner"></span><span class="thinking-label">正在连接模型…</span></span>');
  $('result-files').hidden=true; $('result-files').innerHTML=''; $('result-error').hidden=true; $('result-usage').textContent='';
  $('ai-edit-status').hidden=false; $('ai-edit-status').textContent = result.direct ? t('AI 正在准备修改 · 正文暂时只读，可随时停止') : t('正在准备结果 · 完整内容将在中间显示');
  $('result-status').textContent=t('正在准备');
  let renderAt=0, checkpointAt=0, firstResponseMs=null, usageText='', waitingPhase=t('正在连接模型…');
  const started=performance.now();
  const updateWaiting=()=>{ const label=$('result-content').querySelector('.thinking-label'); if(label)label.textContent=t`${waitingPhase} · 已等待 ${Math.floor((performance.now()-started)/1000)} 秒`; };
  const waitingTimer=setInterval(updateWaiting,1000);
  async function checkpoint(status) {
    if (!result.hasPreview || result.saveFailed || state.doc?.id!==doc.id) return;
    doc._pendingAiEdit={id:result.editId,status};
    try { await saveCurrent(null,doc._pendingAiEdit); checkpointAt=Date.now(); }
    catch(error) { result.saveFailed=true; generationController?.abort(); throw error; }
  }
  async function publish(final=false) {
    if (!result.text.trim() || result.fileTask || state.doc?.id!==doc.id) return;
    if (!result.direct) { showAiReport(result); return; }
    const scroll=$('paper-scroll'), scrollTop=scroll.scrollTop;
    if (!live.update(result.text,final)) return;
    result.hasPreview=true; doc.html=live.html(); doc._dirty=true;
    rememberDraft(doc);
    scroll.scrollTop=scrollTop; updateStats();
    $('result-content').textContent=t('修改正在中间正文中呈现，无需再次应用。');
    $('ai-edit-status').textContent=t('AI 正在修改正文 · 进度自动保存，可停止或在结束后撤回');
    if (!final && Date.now()-checkpointAt>=1000) await checkpoint('streaming');
  }
  try {
    await flushSave();
    const response=await api('/api/generate',{method:'POST',signal:generationController.signal,raw:true,body:{providerId:state.activeProviderId,documentId:doc.id,revision:doc.revision,prompt,mode,outputLanguage:$('output-language').value,selection:mode==='rewrite'?selection.text:'',fragment:mode==='rewrite'?{rich:selection.rich,images:selection.images}:undefined}});
    for await (const event of responseEvents(response.body)) {
      if(event.kind==='delivery')result.fileTask=event.data.fileTask===true;
      if(event.kind==='step') {
        waitingPhase=event.data.tool?t('正在处理文件…'):({prepare:t('正在分析要求…'),plan:t('正在整理结构…'),draft:t('正在生成正文…'),thinking:t('模型正在思考…')})[event.data.phase]||t('正在准备内容…');
        $('result-status').textContent=waitingPhase;updateWaiting();
      }
      if(event.kind==='delta') {
        if(firstResponseMs===null&&event.data.text?.trim())firstResponseMs=performance.now()-started;
        result.text+=event.data.text;
        $('result-status').textContent=result.fileTask?t('正在整理文件结果…'):result.direct?t('正在修改正文…'):t('正在生成结果…');
        if(Date.now()-renderAt>=120){await publish();renderAt=Date.now();}
      }
      if(event.kind==='usage') {
        const usage=event.data,input=usage.prompt_tokens??usage.input_tokens,output=usage.completion_tokens??usage.output_tokens;
        if(input!==undefined||output!==undefined)usageText=t`服务商用量 · 输入 ${input??'—'} / 输出 ${output??'—'} Token`;
      }
      if(event.kind==='error')throw Error(event.data.message);
      if(event.kind==='files') {
        $('result-files').hidden=!event.data.files.length;
        $('result-files').innerHTML=event.data.files.map(file=>`<a class="result-file-link" href="/api/office/file?id=${encodeURIComponent(file.id)}" download>${icon('download')}${e(file.name)}</a>`).join('');
      }
      if(event.kind==='done'){result.complete=true;result.fileTask=event.data.fileTask===true;}
    }
    if(!result.complete)throw Error(t('连接提前结束，已保留接收到的进度。'));
    if(!result.fileTask&&!result.text.trim())throw Error(t('模型未返回可用内容，正文未改动。'));
    await publish(true);
  } catch(error) {
    result.complete=false;result.failure=error;
    $('result-error').textContent=error.name==='AbortError'?t('已停止。已接收的内容会保留，正文修改可整轮撤回。'):t(error.message);
    $('result-error').hidden=false;
  } finally {
    clearInterval(waitingTimer);
    try {
      if(!result.saveFailed){ if(!result.complete)await publish(false); await checkpoint(result.complete?'complete':'interrupted'); }
    } catch(error) {result.complete=false;result.failure=error;$('result-error').textContent=error.message;$('result-error').hidden=false;}
    live?.finish();
    if(result.saveFailed&&doc._pendingAiEdit)doc._pendingAiEdit.status='interrupted';
    setBusy(false);generationController=null;refreshAiControls(false);
    const failedSave=result.saveFailed?t('保存失败 · 请保留页面，复制内容后处理冲突'):null;
    const status=failedSave||(result.fileTask?t('文件任务结束 · 结果见下载链接'):result.direct?(result.hasPreview?(result.complete?t('正文修改完成 · 已自动保存，可撤回'):t('修改未完成 · 已保存接收进度，可撤回')):t('正文未改动')):(result.complete?t('结果已在中间显示'):t('结果未完成 · 已保留接收内容')));
    $('result-status').textContent=status;$('ai-edit-status').textContent=status;
    $('result-content').textContent=result.fileTask?t('文件任务不会覆盖当前正文。'):result.direct?t('正文区域显示完整修改，工具栏可撤回本轮修改。'):t('请在中间查看完整结果；返回正文不会丢失原文。');
    const timing=[firstResponseMs===null?'':t`首段响应 ${(firstResponseMs/1000).toFixed(1)} 秒`,t`总耗时 ${((performance.now()-started)/1000).toFixed(1)} 秒`].filter(Boolean).join(' · ');
    $('result-usage').textContent=[usageText,timing].filter(Boolean).join(' · ');
    clearFragment();
  }
}
async function undoAiEdit() {
  if(state.busy)return;
  await flushSave();
  const doc=state.doc,edit=doc?.aiEdit;
  if(!edit)return;
  async function restore(allowLaterEdits=false) {
    if(state.busy||state.doc?.id!==doc.id)throw Error(t('当前任务或文档已变化，请重新操作。'));
    setBusy(true); $('stop-button').disabled=true;
    try {
      await flushSave();
      const result=await api(`/api/documents/${doc.id}`,{method:'PUT',body:{revision:doc.revision,undoAiEdit:edit.id,allowLaterEdits}});
      Object.assign(doc,result.document);doc._dirty=false;
      $('modal').close();
    } finally { setBusy(false); $('stop-button').disabled=false; }
    renderCurrent();toast(t('已撤回本轮 AI 修改，撤回前版本也已保存'));
  }
  if(edit.appliedRevision!==doc.revision) {
    showModal('', uiHtml('<h2>撤回这轮 AI 修改？</h2><p class="modal-description">AI 修改后还有其他编辑。撤回将恢复本轮 AI 开始前的标题和正文，当前内容会先保留为历史版本。</p><button id="confirm-undo-ai" class="primary">保存当前版本并撤回</button>'));
    $('confirm-undo-ai').onclick=async()=>{ $('confirm-undo-ai').disabled=true;try{await flushSave();await restore(true);}catch(error){$('confirm-undo-ai').disabled=false;toast(error.message,true);} };
  } else await restore();
}

function showHistory() {
  const history = state.doc?.history || [];
  showModal('', uiHtml`<h2>历史版本</h2><p class="modal-description">每轮 AI 修改或恢复版本前，自动保留正文快照。每篇文档最多保留 20 个历史版本。</p><div class="history-list">${history.map(item => uiHtml`<div class="history-row"><span class="history-icon">${icon('clock')}</span><div><strong>${e(item.title)}</strong><small>${formatDate(item.at)} · ${e(item.label)}</small></div><button class="secondary compact" data-restore="${e(item.id)}">恢复</button></div>`).join('') || uiHtml('<p class="empty-state">还没有历史版本。首次 AI 修改后，原文会出现在这里。</p>')}</div>`);
  $('modal-body').querySelectorAll('[data-restore]').forEach(button => { button.onclick = async () => {
    if (state.busy) { toast(t('请先停止生成任务。')); return; }
    const item = state.doc.history.find(entry => entry.id === button.dataset.restore); if (!item) return;
    button.disabled = true;
    try {
      await flushSave(); state.doc.title = item.title; state.doc.html = sanitizeHtml(item.html); state.doc._dirty = true;
      await saveCurrent('恢复版本前'); renderCurrent(); $('modal').close(); toast(t('已恢复版本，恢复前的正文也已保留'));
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }; });
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const filename = title => title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || '文档';
function exportModal() {
  if (!state.doc) { toast(t('请先新建或导入文档。')); return; }
  showModal('', uiHtml`<h2>导出文档</h2><p class="modal-description">选择需要的格式。Word 导出保留标题层级、列表、表格、基础文字格式和图片。</p><div class="export-options"><button data-export="docx"><span class="file-type">W</span><span><strong>Word 文档</strong><small>.docx · 可继续编辑</small></span>${icon('download')}</button><button data-export="md"><span class="file-type md">M↓</span><span><strong>Markdown</strong><small>.md · 纯文本结构</small></span>${icon('download')}</button><button data-export="txt"><span class="file-type txt">T</span><span><strong>纯文本</strong><small>.txt · 简洁通用</small></span>${icon('download')}</button><button data-export="print"><span class="file-type pdf">P</span><span><strong>打印 / 保存为 PDF</strong><small>使用浏览器打印预览</small></span>${icon('arrow')}</button></div>`);
  if ($('editor').querySelector('img')) {
    const note = document.createElement('p'); note.className = 'field-help';
    note.textContent = t('正文包含图片，可使用 Word 或 PDF 导出保留。');
    $('modal-body').querySelector('.export-options').before(note);
  }
  if (window.lingjianDesktop) {
    const pdf = $('modal-body').querySelector('[data-export="print"]');
    pdf.querySelector('strong').textContent = t('保存为 PDF');
    pdf.querySelector('small').textContent = t('保留正文中的图片');
  }
  $('modal-body').querySelectorAll('[data-export]').forEach(button => { button.onclick = async () => {
    const buttons = $('modal-body').querySelectorAll('[data-export]');
    buttons.forEach(option => { option.disabled = true; });
    try {
      await flushSave(); const kind = button.dataset.export, name = filename(state.doc.title);
      if (kind === 'docx') {
        const title = state.doc.title;
        const content = await docxContent($('editor'));
        const response = await api('/api/export/docx', { method: 'POST', raw: true, body: { title, ...content } });
        download(await response.blob(), `${name}.docx`);
      } else if (kind === 'md') download(new Blob([`# ${state.doc.title}\n\n${editorMarkdown($('editor'))}\n`], { type: 'text/markdown;charset=utf-8' }), `${name}.md`);
      else if (kind === 'txt') download(new Blob([`${state.doc.title}\n\n${$('editor').innerText}`], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
      $('modal').close();
      if (kind !== 'print') toast(t('导出已开始'));
      else if (!window.lingjianDesktop) window.print();
      else if (await window.lingjianDesktop.savePdf(name, language)) toast(t('PDF 已保存'));
    } catch (error) { toast(error.message, true); }
    finally { buttons.forEach(option => { option.disabled = false; }); }
  }; });
}

function bindEvents() {
  narrowWorkspace = window.matchMedia('(max-width: 1100px)');
  officeUI = initOffice({api,toast,showModal,createDocument,beforeAgent:flushSave,getContext:()=>({providerId:state.activeProviderId,documentId:state.doc?.id}),openSettings:()=>{setView('settings');fillProvider(activeProvider());},addSource:async source=>{
    if (!state.doc) throw new Error(t('请先创建文档。'));
    if (state.doc.sources.length>=20 || source.text.length>300000 || state.doc.sources.reduce((sum,item)=>sum+item.text.length,source.text.length)>500000) throw new Error(t('参考资料超过数量或字符限制，请移除部分资料后重试。'));
    state.doc.sources.push({id:crypto.randomUUID(),...source,enabled:true});state.doc._dirty=true;await saveCurrent();renderSources();
  }});
  document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => setView(button.dataset.view); });
  $('new-document').onclick = newDocumentModal;
  $('document-list').onclick = event => { const remove = event.target.closest('[data-delete-document]'), doc = event.target.closest('[data-document]'); if (remove) confirmDeleteDocument(remove.dataset.deleteDocument); else if (doc) selectDocument(doc.dataset.document).catch(error => toast(error.message, true)); };
  $('outline-list').onclick = event => { const button = event.target.closest('[data-heading]'); if (button) $('editor').querySelectorAll('h1,h2,h3,h4')[Number(button.dataset.heading)]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  $('document-title').addEventListener('input', dirty); $('editor').addEventListener('input', dirty);
  $('editor').addEventListener('paste', event => {
    event.preventDefault();
    const image = [...event.clipboardData.files].find(file => file.type.startsWith('image/'));
    if (image) { insertImage(image).catch(error => toast(error.message, true)); return; }
    const html = sanitizeHtml(event.clipboardData.getData('text/html'));
    if (html) document.execCommand('insertHTML', false, html);
    else document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    dirty();
  });
  $('editor').addEventListener('drop', event => { event.preventDefault(); const image = [...event.dataTransfer.files].find(file => file.type.startsWith('image/')); if (image) insertImage(image).catch(error => toast(error.message, true)); });
  $('editor').addEventListener('click', event => {
    if (event.target.tagName !== 'IMG') return;
    const range = document.createRange(); range.selectNode(event.target);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  bindEditorContextMenu($('editor'));
  $('remove-fragment').onclick = () => clearFragment();
  $('task-mode').onchange = () => clearFragment({ keepRewrite: true });
  $('insert-image').onmousedown = event => event.preventDefault();
  $('insert-image').onclick = () => $('image-file').click();
  $('image-file').onchange = async event => { try { if (event.target.files[0]) await insertImage(event.target.files[0]); } catch (error) { toast(error.message, true); } finally { event.target.value = ''; } };
  document.querySelectorAll('[data-command]').forEach(button => { button.onmousedown = event => event.preventDefault(); button.onclick = () => { $('editor').focus(); document.execCommand(button.dataset.command); dirty(); }; });
  $('format-block').onchange = () => { $('editor').focus(); document.execCommand('formatBlock', false, $('format-block').value); dirty(); };
  $('insert-table').onmousedown = event => event.preventDefault();
  $('insert-table').onclick = () => { $('editor').focus(); document.execCommand('insertHTML', false, uiHtml('<table><thead><tr><th>项目</th><th>说明</th><th>备注</th></tr></thead><tbody><tr><td>待补充</td><td>待补充</td><td>待补充</td></tr><tr><td>待补充</td><td>待补充</td><td>待补充</td></tr></tbody></table><p><br></p>')); dirty(); };
  const setAssistantOpen = open => {
    $('assistant-panel').classList.toggle('collapsed', !open);
    $('focus-toggle').classList.toggle('inactive', !open);
    $('focus-toggle').setAttribute('aria-expanded', String(open));
  };
  setAssistantOpen(false);
  $('focus-toggle').onclick = () => {
    const open = getComputedStyle($('assistant-panel')).display === 'none';
    if (open) annotationUI?.close();
    if (open && narrowWorkspace.matches) {
      if (!$('quality-view').hidden) $('quality-close').click();
      if (!$('studio-view').hidden) $('studio-close').click();
    }
    setAssistantOpen(open);
    if (open) $('assistant-close').focus();
  };
  $('assistant-close').onclick = () => { setAssistantOpen(false); $('focus-toggle').focus(); };
  const menu = $('document-menu');
  const menuTrigger = menu.querySelector('summary');
  menu.addEventListener('click', event => {
    if (event.target.closest('button')) { annotationUI?.close(); menu.open = false; menuTrigger.focus(); }
  }, true);
  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (menu.open) { menu.open = false; menuTrigger.focus(); }
    else if ($('annotation-panel').contains(document.activeElement)) $('annotation-close').click();
    else if ($('assistant-panel').contains(document.activeElement)) $('assistant-close').click();
  });
  $('document-title').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('editor').focus(); }
  });
  bindSidebar();
  $('history-button').onclick = showHistory; $('export-button').onclick = exportModal;
  $('manual-print').onclick = () => {
    // 折叠的问答在纸面上只剩问句，打印前统一展开，打印后再折回原样。
    const collapsed = [...document.querySelectorAll('#manual-view details')].filter(item => !item.open);
    collapsed.forEach(item => { item.open = true; });
    window.addEventListener('afterprint', () => collapsed.forEach(item => { item.open = false; }), { once: true });
    window.print();
  };
  $('modal-close').onclick = () => $('modal').close(); $('modal').onclick = event => { if (event.target === $('modal')) { const rect = $('modal').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('modal').close(); } };
  $('template-search').oninput = renderTemplates;
  $('template-format').onchange = event => { state.templateFormat = event.target.value; renderTemplates(); };
  $('template-language').value = state.templateLanguage;
  $('template-language').onchange = event => { state.templateLanguage = event.target.value; renderTemplates(); };
  $('template-categories').onclick = event => { const button = event.target.closest('[data-category]'); if (button) { state.category = button.dataset.category; renderTemplates(); } };
  $('template-grid').onclick = event => { const button = event.target.closest('[data-template]'); if (button) previewTemplate(button.dataset.template); };
  $('composer-settings').onclick = () => { setView('settings'); fillProvider(activeProvider()); };
  $('add-provider').onclick = () => { fillProvider(); $('provider-name').focus(); };
  $('provider-list').onclick = event => { const remove = event.target.closest('[data-delete-provider]'), provider = event.target.closest('[data-provider]'); if (remove) deleteProvider(remove.dataset.deleteProvider); else if (provider) fillProvider(state.providers.find(item => item.id === provider.dataset.provider)); };
  $('provider-form').onsubmit = saveProvider; $('test-provider').onclick = testProvider;
  $('provider-vendor').onchange = applyProviderPreset;
  $('provider-url').oninput = () => { updateEndpoint(); updateProviderPreset(); };
  $('provider-protocol').onchange = () => { updateEndpoint(); updateProviderPreset(); };
  $('provider-key').oninput = updateProviderPreset;
  $('fetch-provider-models').onclick = fetchProviderModels;
  $('provider-model-choice').onchange = () => { if ($('provider-model-choice').value) { $('provider-model').value = $('provider-model-choice').value; $('connection-result').hidden = true; } };
  $('provider-model').oninput = () => { $('provider-model-choice').value = $('provider-model').value; if ($('provider-model-choice').selectedIndex < 0) $('provider-model-choice').value = ''; $('connection-result').hidden = true; };
  $('toggle-key').onclick = () => { $('provider-key').type = $('provider-key').type === 'password' ? 'text' : 'password'; };
  $('assistant-model').onchange = async () => { const previous = state.activeProviderId; state.activeProviderId = $('assistant-model').value; try { await api('/api/active-provider', { method: 'PUT', body: { id: state.activeProviderId } }); renderModelPicker(); } catch (error) { state.activeProviderId = previous; renderModelPicker(); toast(error.message, true); } };
  $('writing-tab').onclick = () => switchAssistant('writing'); $('sources-tab').onclick = () => switchAssistant('sources');
  $('add-source').onclick = () => $('source-file').click(); $('source-file').onchange = async event => { try { await addSources([...event.target.files]); } catch (error) { toast(error.message, true); } finally { event.target.value = ''; } };
  $('sources-list').onclick = event => { const button = event.target.closest('[data-remove-source]'); if (button) { state.doc.sources = state.doc.sources.filter(item => item.id !== button.dataset.removeSource); state.doc._dirty = true; renderSources(); saveCurrent().catch(error => toast(error.message, true)); } };
  $('sources-list').onchange = event => { if (event.target.dataset.sourceToggle) { state.doc.sources.find(item => item.id === event.target.dataset.sourceToggle).enabled = event.target.checked; state.doc._dirty = true; renderSources(); saveCurrent().catch(error => toast(error.message, true)); } };
  document.querySelectorAll('[data-quick]').forEach(button => { button.onclick = () => {
    if (state.busy) return;
    if (!state.doc) { toast(t('请先新建或导入文档。')); return; }
    const mode = button.dataset.quick; $('task-mode').value = mode;
    updateWritingNote();
    $('writing-prompt').value = ({ outline: t`请为《${state.doc.title}》拟一份清晰的大纲，标出各节需要补充的资料。`, write: t`请按照当前${currentTemplate()?.title || t('文档')}的结构撰写正文。面向：待补充；写作目标：待补充。没有依据的信息请标注待补充。`, review: t('请检查全文的逻辑、结构、数字与术语一致性，指出具体问题并给出修改建议。') })[mode]; $('writing-prompt').focus();
  }; });
  $('generate-button').onclick = () => generate().catch(error => { setBusy(false); toast(error.message, true); });
  $('stop-button').onclick = () => generationController?.abort();
  $('writing-prompt').onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('generate-button').click(); } };
  $('undo-ai-edit').onclick = () => undoAiEdit().catch(error => toast(error.message, true));
  $('close-ai-report').onclick = closeAiReport;
  $('copy-result').onclick = async () => { try { await navigator.clipboard.writeText(state.result?.text || ''); toast(t('已复制生成内容')); } catch { toast(t('复制失败，请在中间选择内容后手动复制。'), true); } };
  $('import-document').onclick = () => $('document-file').click();
  $('document-file').onchange = async event => { try { const file = event.target.files[0]; if (file) { if (/\.(docx|pdf|xlsx|xlsm|pptx)$/i.test(file.name)) { toast(t('正在提取 Office 文件内容…'));const data=await officeUI.uploadAndExtract(file);await createDocument(data.title,null,data.html);if(data.warnings.length)toast(data.warnings.join(' ')); } else { if (!/\.(txt|md|markdown)$/i.test(file.name)) throw new Error(t('请选择文本、Word、Excel、PPT 或 PDF 文件。')); const text = await readTextFile(file); await createDocument(file.name.replace(/\.[^.]+$/, ''), null, /\.(md|markdown)$/i.test(file.name) ? markdownToHtml(text) : `<p>${e(text).replaceAll('\n', '<br>')}</p>`); } } } catch (error) { toast(error.message, true); } finally { event.target.value = ''; } };
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (state.busy) { toast(t('AI 修改正在自动保存。')); return; } saveCurrent().then(() => toast(t('已保存'))).catch(error => toast(error.message, true)); } });
}
function refreshDocuments(documents, restoredDraft) {
  const current = state.doc;
  const local = new Map(state.documents.map(doc => [doc.id, doc]));
  const restored = restoredDraft && local.get(restoredDraft.id);
  if (restored?._dirty && !savingDocuments.has(restored) && !(state.busy && restored === current) && sameDraftContent(restored, restoredDraft)) {
    recovery.acknowledge(recoveryOwner(), restored);
    restored._dirty = false;
  }
  const pending = doc => {
    if (savingDocuments.has(doc) || (state.busy && doc === current)) return true;
    return doc._dirty;
  };
  state.documents = documents.map(saved => {
    const doc = local.get(saved.id);
    local.delete(saved.id);
    // Keep the original revision for pending edits so the server still detects conflicts.
    return doc && (pending(doc) || doc.revision > saved.revision) ? doc : saved;
  });
  state.documents.push(...[...local.values()].filter(pending));
  state.doc = state.documents.find(doc => doc.id === current?.id) || state.documents[0] || null;
  if (state.doc && state.doc === current) {
    renderDocuments();
    return;
  }
  renderCurrent();
  saveNotice();
}
async function openWorkspace(data) {
  const { notice, ...workspace } = data;
  Object.assign(state, workspace);
  if (!backupUI) {
    adminUI = initAdmin({ api, toast, getUser: () => state.user });
    bindEvents();
    qualityUI = initQuality({ api, state, toast, showModal, flushSave, renderTemplates });
    studioUI = initStudio({ api, state, toast, showModal, flushSave, applyDocument, selectDocument, renderDocuments });
    annotationUI = initAnnotations({
      api, state, toast, showModal, flushSave, narrow: () => narrowWorkspace.matches,
      revealEditor: () => {
        if (!$('quality-view').hidden) qualityUI.reset();
        if (!$('studio-view').hidden) studioUI.reset();
        if (!$('ai-report-view').hidden) closeAiReport();
        if (!$('assistant-panel').classList.contains('collapsed')) $('assistant-close').click();
      }
    });
    backupUI = initBackupUI({ api, state, flushSave, showModal, toast, download, recovery, refreshDocuments });
    $('retry-save').onclick = () => saveCurrent().then(() => toast(t('已保存'))).catch(error => toast(error.message, true));
    $('forget-key').onclick = async () => {
      try { const result = await api(`/api/providers/${encodeURIComponent($('provider-id').value)}/key`, { method: 'DELETE' }); const index = state.providers.findIndex(item => item.id === result.provider.id); if (index >= 0) state.providers[index] = result.provider; fillProvider(result.provider); toast(t('密钥已清除（包括此账号的其他会话）')); } catch (error) { toast(error.message, true); }
    };
    $('logout-button').onclick = async () => {
      try { await flushSave(); await api('/api/auth/logout', { method: 'POST', body: {} }); lockWorkspace(); window.location.reload(); } catch (error) { toast(error.message, true); }
    };
  }
  $('admin-nav').hidden = state.user?.role !== 'admin';
  backupUI.updateCount();
  $('auth-panel').hidden = true; $('workspace-shell').hidden = false;
  if (state.user) {
    $('account-name').textContent = state.user.username;
    $('account-menu').hidden = false;
    document.querySelector('.sidebar-bottom').append($('account-menu'));
  }
  $('provider-vendor').innerHTML = uiHtml('<option value="custom">自定义 · OpenAI / 兼容接口</option>') + state.providerPresets.map(preset => `<option value="${e(preset.id)}">${e(preset.name)}</option>`).join('');
  let current;
  try { current = localStorage.getItem(`lingjian.currentDocument.${recoveryOwner()}`); } catch {}
  state.doc = state.documents.find(doc => doc.id === current) || state.documents[0];
  setView('documents'); saveNotice();
  if (notice) toast(notice, true);
  renderCurrent(); renderModelPicker(); fillProvider(activeProvider());
}
async function boot() {
  try {
    await prepareAuth();
    await openWorkspace(await api('/api/bootstrap'));
  } catch (error) { if (error.status === 401) { $('auth-panel').hidden = false; $('auth-username').focus(); return; } $('save-status').textContent = t('连接服务失败'); toast(t`工作台初始化失败：${error.message}。请检查服务并刷新。`, true); }
}
function protectUnsaved() {
  for (const doc of state.documents) {
    if (doc._dirty || savingDocuments.has(doc)) rememberDraft(doc);
  }
}
function lockWorkspace(expired = false) {
  protectUnsaved();
  clearTimeout(saveTimer); generationController?.abort(); modelListController?.abort();
  state.token = ''; state.documents = []; state.providers = []; state.doc = null; state.busy = false; state.result = null; state.selection = null;
  $('workspace-shell').hidden = true; $('account-menu').hidden = true; $('modal').close(); $('provider-form').reset(); $('editor').innerHTML = '';
  $('auth-panel').hidden = false; $('auth-password').value = '';
  if (expired) {
    $('auth-error').textContent = recovery.hasVolatile(recoveryOwner())
      ? t('请在此页面重新登录原账号。浏览器无法存储部分草稿，退出或刷新会丢失这些修改。')
      : t('会话已结束。重新登录后可从「恢复草稿」查看尚未保存的修改。');
    $('auth-error').hidden = false;
  }
}
async function prepareAuth() {
  const config = await api('/api/auth/status');
  if (config.mode === 'local') return;
  let register = false;
  $('auth-toggle').hidden = !config.registration;
  $('auth-toggle').onclick = () => {
    register = !register; $('auth-title').textContent = register ? t('创建你的工作空间') : t('登录你的工作空间');
    $('auth-submit').textContent = register ? t('注册并登录') : t('登录');
    $('auth-toggle').textContent = register ? t('已有账号？登录') : t('还没有账号？注册');
    $('auth-password').autocomplete = register ? 'new-password' : 'current-password';
    $('auth-invite-field').hidden = !(register && config.inviteRequired); $('auth-invite').required = register && config.inviteRequired;
    $('auth-error').hidden = true;
  };
  $('auth-form').onsubmit = async event => {
    event.preventDefault(); $('auth-submit').disabled = true; $('auth-error').hidden = true;
    try {
      const { user } = await api(`/api/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: { username: $('auth-username').value, password: $('auth-password').value, inviteCode: $('auth-invite').value } });
      $('auth-form').reset();
      if (user.id === state.user?.id && recovery.hasVolatile(user.id)) {
        await saveTail.catch(() => {});
        const data = await api('/api/bootstrap');
        if (data.user?.id !== user.id) throw new Error(t('当前登录账号已切换，请重新登录原账号。'));
        await openWorkspace(data);
        backupUI.drafts();
      } else {
        window.location.reload();
      }
    } catch (error) { $('auth-error').textContent = error.message; $('auth-error').hidden = false; }
    finally { $('auth-submit').disabled = false; }
  };
}
window.addEventListener('storage', event => {
  if (event.key === null || event.key.startsWith('lingjian.recovery.')) backupUI?.updateCount();
});
window.addEventListener('pagehide', protectUnsaved);
window.addEventListener('beforeunload', event => {
  if (recovery.hasVolatile(recoveryOwner()) || state.busy || savingDocuments.size || state.documents.some(doc => doc._dirty)) {
    protectUnsaved();
    event.preventDefault();
    event.returnValue = '';
  }
});
function bindLanguages() {
  const output = $('output-language');
  const outputPreference = 'lingjian.outputLanguage';
  try {
    const saved = localStorage.getItem(outputPreference);
    if (saved === 'zh-CN' || saved === 'en') output.value = saved;
  } catch {}
  output.addEventListener('change', () => {
    try { localStorage.setItem(outputPreference, output.value); } catch {}
  });
  for (const picker of document.querySelectorAll('[data-language-picker]')) {
    picker.value = language;
    picker.addEventListener('change', async () => {
      const next = picker.value;
      picker.value = language;
      if (state.busy || officeUI?.busy || studioUI?.busy) {
        toast(t('请先结束或停止当前任务，再切换界面语言。'), true);
        return;
      }
      picker.disabled = true;
      try {
        await flushSave();
        if (state.documents.some(doc => doc._dirty) || recovery.hasVolatile(recoveryOwner())) {
          toast(t('无法保存当前文档，请先保存后再切换语言。'), true);
          return;
        }
        changeLanguage(next);
      } catch (error) { toast(t(error.message), true); }
      finally { picker.disabled = false; }
    });
  }
}

localizePage();
bindLanguages();
boot();
