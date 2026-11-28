import { t } from './i18n.js';

const officeToolLabels = {read_docx:t('读取 Word'),write_docx:t('生成 Word'),edit_docx:t('编辑 Word'),read_xlsx:t('读取 Excel'),write_xlsx:t('生成 Excel'),edit_xlsx:t('编辑 Excel'),read_pptx:t('读取 PPT'),write_pptx:t('生成 PPT'),write_pptx_design:t('生成设计版 PPT'),edit_pptx:t('编辑 PPT'),pdf_info:t('PDF 信息'),pdf_extract_text:t('提取 PDF 文本'),pdf_render_pages:t('预览 PDF 页面'),pdf_apply_modifications:t('批量修改 PDF'),pdf_save:t('保存 PDF 修改'),pdf_manual_replace_text:t('替换 PDF 区域文字'),pdf_redact:t('遮盖 PDF 区域'),pdf_highlight_area:t('高亮 PDF 区域'),pdf_deyellow:t('扫描件去黄底'),pdf_add_text:t('给 PDF 添加文字'),list_directory:t('浏览文件库'),read_file:t('读取文本'),write_file:t('写入文本'),edit_file:t('替换文本'),file_info:t('文件信息'),create_directory:t('创建文件夹'),move_file:t('移动文件'),delete_file:t('删除文件'),read_image:t('查看图片'),preview_document_edits:t('核验修改建议')};
officeToolLabels.check_docx = t('DOCX 交付检查');
officeToolLabels.search_sources = t('资料检索与引用定位');
officeToolLabels.inspect_document = t('定位文档原文');
officeToolLabels.edit_document = t('精确修改并核对文档');
officeToolLabels.ocr_document = t('识别扫描件与图片文字');
export const officeToolLabel = name => Object.hasOwn(officeToolLabels, name) ? officeToolLabels[name] : name;

export async function* responseEvents(body) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const kind = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
        if (kind && data) yield { kind, data: JSON.parse(data) };
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
}

const statuses = {
  running: '进行中',
  done: '已完成',
  failed: '未完成',
  attention: '待核对',
  stopped: '已停止',
  interrupted: '连接已中断'
};

export function createActivityTimeline(panel) {
  const summary = panel.querySelector('summary');
  const list = panel.querySelector('ol');
  const storageKey = `lingjian.activity.${panel.id}`;
  const logs = new Map();
  let activeScope = null;
  try {
    for (const [scope, entries] of JSON.parse(sessionStorage.getItem(storageKey) || '[]')) {
      const steps = new Map(entries.map(entry => [
        entry.id, entry.status === 'running' ? { ...entry, status: 'interrupted' } : entry
      ]));
      if (entries.length && entries.at(-1).label !== '任务结果') {
        steps.set('interrupted', { id: 'interrupted', label: '任务结果', status: 'interrupted' });
      }
      logs.set(scope, steps);
    }
  } catch { logs.clear(); }

  function render() {
    const entries = [...(activeScope ? logs.get(activeScope)?.values() || [] : [])];
    panel.hidden = !entries.length;
    const last = entries.at(-1);
    const status = last?.label === '任务结果' ? last.status : last ? 'running' : null;
    summary.textContent = status && Object.hasOwn(statuses, status)
      ? t`工作过程 · ${t(statuses[status])}` : t('工作过程');
    const follow = list.scrollHeight - list.clientHeight - list.scrollTop < 30;
    const rows = entries.map(entry => {
      const row = document.createElement('li');
      row.dataset.status = entry.status;
      const title = document.createElement('span');
      title.className = 'activity-title';
      title.textContent = entry.tool ? officeToolLabel(entry.tool) : t(entry.label);
      row.append(title);
      if (Object.hasOwn(statuses, entry.status)) {
        const status = document.createElement('span');
        status.className = 'activity-status';
        status.textContent = t(statuses[entry.status]);
        row.append(status);
      }
      const files = Array.isArray(entry.files) && entry.files.length ? entry.files.join('、') : '';
      const outputs = Array.isArray(entry.outputs) && entry.outputs.length ? t`产物：${entry.outputs.join('、')}` : '';
      const details = [entry.detail ? t(entry.detail) : '', files, outputs].filter(Boolean).join(' · ');
      if (details) {
        const detail = document.createElement('small');
        detail.textContent = details;
        row.append(detail);
      }
      return row;
    });
    list.replaceChildren(...rows);
    if (follow) list.scrollTop = list.scrollHeight;
  }

  function show(scope) { activeScope = scope; render(); }
  function start(scope) {
    const entries = new Map();
    logs.delete(scope);
    logs.set(scope, entries);
    if (logs.size > 16) logs.delete(logs.keys().next().value);
    show(scope);
    panel.open = true;
    const changed = () => {
      try { sessionStorage.setItem(storageKey, JSON.stringify([...logs].map(([key, rows]) => [key, [...rows.values()]]))); }
      catch { /* Timeline remains available in memory when browser storage is full or disabled. */ }
      if (activeScope === scope) render();
    };
    const update = entry => { entries.set(entry.id, entry); changed(); };
    const record = (label, status = 'notice', details = {}) => {
      const id = crypto.randomUUID();
      const publish = nextStatus => update({ id, label, ...details, status: nextStatus });
      publish(status);
      return publish;
    };
    return {
      update, record,
      finish(status) {
        for (const [id, entry] of entries) if (entry.status === 'running') {
          entries.set(id, { ...entry, status: entry.tool ? 'attention' : status === 'done' ? 'interrupted' : status });
        }
        record('任务结果', status);
      }
    };
  }
  return { show, start };
}
