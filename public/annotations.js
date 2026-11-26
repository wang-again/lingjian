import { escapeHtml as e } from './editor.js';
import { t, uiHtml } from './i18n.js';

export function findAnnotationOffset(text, { quote, prefix, suffix }) {
  if (!quote) return -1;
  const first = text.indexOf(quote);
  if (first < 0 || text.indexOf(quote, first + 1) < 0) return first;
  if (!prefix && !suffix) return -1;
  let match = -1;
  for (let offset = first; offset >= 0; offset = text.indexOf(quote, offset + 1)) {
    const end = offset + quote.length;
    if ((prefix && text.slice(Math.max(0, offset - prefix.length), offset) !== prefix)
        || (suffix && text.slice(end, end + suffix.length) !== suffix)) continue;
    if (match >= 0) return -1;
    match = offset;
  }
  return match;
}

function selectedAnchor(editor) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  if (quote.length > 800) throw new Error(t('一次最多为 800 字添加批注。'));
  const before = document.createRange();
  before.selectNodeContents(editor);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length;
  const source = editor.textContent;
  return { quote, prefix: source.slice(Math.max(0, offset - 32), offset), suffix: source.slice(offset + quote.length, offset + quote.length + 32) };
}

function rangeAt(editor, offset, length) {
  const nodes = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let startSet = false;
  let cursor = 0;
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    const end = cursor + node.length;
    if (!startSet && offset < end) {
      range.setStart(node, offset - cursor);
      startSet = true;
    }
    if (startSet && offset + length <= end) {
      range.setEnd(node, offset + length - cursor);
      return range;
    }
    cursor = end;
  }
  return null;
}

export function initAnnotations({ state, api, flushSave, toast, showModal, revealEditor, narrow }) {
  const $ = id => document.getElementById(id);
  const editor = $('editor');
  const panel = $('annotation-panel');
  const list = $('annotation-list');
  let saving = false;

  function render() {
    const items = state.doc?.annotations || [];
    list.innerHTML = items.length
      ? items.map(item => uiHtml`<article class="claim-row"><div class="claim-head"><span class="status-pill">${e(item.resolved ? t('已解决') : t('待处理'))}</span></div>
        <blockquote class="claim-quote">${e(item.anchor.quote)}</blockquote>
        <p class="annotation-note">${e(item.note)}</p>
        <div class="annotation-actions">
          <button class="text-button" data-annotation="locate" data-id="${e(item.id)}">定位正文</button>
          <button class="text-button" data-annotation="reanchor" data-id="${e(item.id)}">改用当前选区</button>
          <button class="secondary compact" data-annotation="status" data-id="${e(item.id)}">${e(item.resolved ? t('重新打开') : t('标记已解决'))}</button>
        </div>
      </article>`).join('')
      : uiHtml('<p class="quality-empty">选中正文里的文字，然后点击「添加批注」。</p>');
  }

  function close() {
    panel.hidden = true;
    $('annotations-button').setAttribute('aria-expanded', 'false');
  }

  function open() {
    if (!state.doc) return;
    revealEditor();
    panel.hidden = false;
    $('annotations-button').setAttribute('aria-expanded', 'true');
    render();
  }

  async function save(current, route, method, body) {
    if (saving || state.busy) return false;
    saving = true;
    try {
      await flushSave();
      if (state.doc !== current) throw new Error(t('文档已切换，请重新选取原文。'));
      const result = await api(`/api/documents/${current.id}/annotations${route}`, {
        method, body: { ...body, revision: current.revision }
      });
      current.annotations = result.annotations;
      if (state.doc === current) render();
      return true;
    } finally {
      saving = false;
    }
  }

  function add() {
    if (!state.doc || state.busy) return;
    const current = state.doc;
    const anchor = selectedAnchor(editor);
    if (!anchor) throw new Error(t('请先选中要批注的正文。'));
    const id = crypto.randomUUID();
    showModal('', uiHtml`<h2>添加批注</h2><blockquote class="claim-quote">${e(anchor.quote)}</blockquote>
      <label class="modal-label">批注内容<textarea id="annotation-note" rows="4" maxlength="1000" required></textarea></label>
      <div class="modal-choice"><button id="annotation-save" class="primary">保存批注</button></div>`);
    $('annotation-note').focus();
    $('annotation-save').onclick = async event => {
      const button = event.currentTarget;
      const note = $('annotation-note').value.trim();
      if (!note) { toast(t('请填写批注内容。'), true); $('annotation-note').focus(); return; }
      button.disabled = true;
      try {
        if (await save(current, '', 'POST', { id, anchor, note })) {
          $('modal').close();
          if (state.doc === current) open();
        }
      } catch (error) { toast(error.message, true); }
      finally { button.disabled = false; }
    };
  }

  $('annotations-button').onclick = () => { if (panel.hidden) open(); else close(); };
  $('annotations-button').onmousedown = event => event.preventDefault();
  $('annotation-close').onclick = () => { close(); $('annotations-button').focus(); };
  $('add-annotation').onmousedown = event => event.preventDefault();
  $('add-annotation').onclick = () => { try { add(); } catch (error) { toast(error.message, true); } };
  list.addEventListener('mousedown', event => {
    if (event.target.closest('[data-annotation="reanchor"]')) event.preventDefault();
  });
  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-annotation]');
    const current = state.doc;
    const item = current?.annotations?.find(entry => entry.id === button?.dataset.id);
    if (!item) return;
    const action = button.dataset.annotation;
    try {
      if (action === 'locate') {
        const offset = findAnnotationOffset(editor.textContent, item.anchor);
        const range = offset < 0 ? null : rangeAt(editor, offset, item.anchor.quote.length);
        if (!range) throw new Error(t('原文已变化或有多处匹配。请选中正确文字后点击「改用当前选区」。'));
        if (narrow()) close();
        editor.focus({ preventScroll: true });
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const parent = range.startContainer.parentElement;
        parent?.scrollIntoView({ block: 'center' });
        return;
      }
      const anchor = action === 'reanchor' ? selectedAnchor(editor) : null;
      if (action === 'reanchor' && !anchor) throw new Error(t('请先选中新的批注位置。'));
      button.disabled = true;
      await save(current, `/${item.id}`, 'PATCH', anchor ? { anchor } : { resolved: !item.resolved });
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });

  return { close, refresh: () => { if (!panel.hidden) render(); } };
}
