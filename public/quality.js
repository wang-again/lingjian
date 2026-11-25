import { language, t, uiHtml } from './i18n.js';
import { escapeHtml as e } from './editor.js';

// 文档质量工作台：简报、依据台账与交付体检。
// 这里只负责呈现与定位；所有核验结论都由服务端基于当前正文和为资料计算。

const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="/icon.svg#${name}"/></svg>`;

const CLAIM_STATUS = {
  supported: { label: t('已支持'), tone: 'ok' },
  uncited: { label: t('待补引用'), tone: 'info' },
  weak: { label: t('引用待核'), tone: 'warn' },
  'needs-check': { label: t('仅少量重合'), tone: 'warn' },
  unverified: { label: t('无依据'), tone: 'warn' },
  broken: { label: t('引用失效'), tone: 'bad' }
};
const ISSUE_CATEGORY = { placeholder: t('占位内容'), structure: t('结构'), table: t('表格'), citation: t('引用'), brief: t('简报'), evidence: t('依据'), consistency: t('一致性'), content: t('内容') };
const GRADE = {
  ready: { label: t('未发现阻断项'), tone: 'ready' },
  review: { label: t('建议确认后交付'), tone: 'review' },
  blocked: { label: t('需处理后交付'), tone: 'blocked' }
};

let app = null;
let filter = 'all';
let lastLedger = null;
let lastReport = null;
let view = null;

const doc = () => app.state.doc;
const isStale = record => Boolean(record) && doc()?.revision !== record.forRevision;

function setBadge(id, text, tone = '') {
  const node = $(id);
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || '';
  if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
}

function briefPercent(brief) {
  if (!brief) return 0;
  const checks = [brief.purpose, brief.audience, brief.scope, brief.sourcePolicy, brief.keyPoints?.length, brief.terminology?.length, brief.constraints];
  return Math.round(checks.filter(Boolean).length / 7 * 100);
}

function refreshIndicators() {
  const current = doc();
  if (!current) {
    for (const id of ['brief-state', 'evidence-state', 'delivery-state']) setBadge(id, '');
    return;
  }
  const percent = briefPercent(current.brief);
  setBadge('brief-state', current.brief ? `${percent}%` : t('未填'), current.brief ? (percent >= 70 ? 'ok' : 'warn') : 'warn');
  const ledger = current.evidence;
  setBadge('evidence-state', isStale(ledger) ? t('过期') : ledger ? `${ledger.summary.total}` : '', isStale(ledger) ? 'stale' : ledger?.summary.broken ? 'bad' : 'ok');
  const report = current.delivery;
  setBadge('delivery-state', isStale(report) ? t('过期') : report ? ({ ready: t('通过'), review: t('待确认'), blocked: t('需处理') })[report.grade] : '', isStale(report) ? 'stale' : report?.grade === 'blocked' ? 'bad' : report?.grade === 'review' ? 'warn' : 'ok');
}

function reset() {
  view = null; lastLedger = null; lastReport = null; filter = 'all';
  const panel = $('quality-view');
  if (panel) panel.hidden = true;
  document.body.classList.remove('quality-open');
  const paper = $('paper-scroll');
  if (paper) paper.hidden = false;
  $('quality-content')?.replaceChildren();
  refreshIndicators();
}

async function saveBrief(brief) {
  const current = doc();
  if (!current) return;
  current.brief = brief;
  current._dirty = true;
  await app.flushSave();
  $('modal').close();
  refreshIndicators();
  app.toast(brief ? t('文档简报已保存，后续写作会自动带入') : t('文档简报已清空'));
}

function openBrief() {
  const current = doc();
  if (!current) { app.toast(t('请先新建或导入文档。')); return; }
  const brief = current.brief || {};
  const points = (brief.keyPoints || []).join('\n');
  const terms = (brief.terminology || []).map(item => item.definition ? `${item.term}=${item.definition}` : item.term).join('\n');
  app.showModal('DOCUMENT BRIEF', uiHtml`<h2>文档简报</h2><p class="modal-description">说明这份文档为谁、为什么写、依据什么。简报只作为写作约束，不会被当成事实证据；留空即表示不启用。</p><div class="brief-form">
    <label>写作目的<textarea id="brief-purpose" rows="2" maxlength="500" placeholder="例如：支持管理层决定是否启动二期">${e(brief.purpose || '')}</textarea></label>
    <label>目标读者<textarea id="brief-audience" rows="2" maxlength="300" placeholder="例如：管理层与区域负责人；已了解一期进展">${e(brief.audience || '')}</textarea></label>
    <label>范围与边界<textarea id="brief-scope" rows="2" maxlength="500" placeholder="例如：只覆盖华东区 2026 年第一季度，不含海外业务">${e(brief.scope || '')}</textarea></label>
    <label>关键事实<textarea id="brief-points" rows="3" maxlength="3600" placeholder="每行一条必须准确写入的数字、结论或名称">${e(points)}</textarea></label>
    <label>术语与口径<textarea id="brief-terms" rows="2" maxlength="3000" placeholder="每行一条：术语=说明，例如：ARPU=单用户平均收入">${e(terms)}</textarea></label>
    <label>交付约束<textarea id="brief-constraints" rows="2" maxlength="800" placeholder="例如：不超过 3 页；先给结论再给依据">${e(brief.constraints || '')}</textarea></label>
    <label>资料与引用策略<textarea id="brief-policy" rows="2" maxlength="500" placeholder="例如：只使用已上传资料；关键数据必须标注来源">${e(brief.sourcePolicy || '')}</textarea></label>
  </div><p class="field-help">简报会随每次写作任务一起发送给你配置的模型，不会上传到其他服务。</p><div class="modal-choice"><button class="secondary" id="brief-cancel">取消</button><button class="primary" id="brief-save">保存简报</button></div>`);
  $('brief-cancel').onclick = () => $('modal').close();
  $('brief-save').onclick = async () => {
    const button = $('brief-save'); button.disabled = true;
    try {
      const value = {
        purpose: $('brief-purpose').value.trim(),
        audience: $('brief-audience').value.trim(),
        scope: $('brief-scope').value.trim(),
        keyPoints: $('brief-points').value.split('\n').map(item => item.trim()).filter(Boolean),
        terminology: $('brief-terms').value.split('\n').map(line => {
          const match = /^(.+?)\s*[=＝:：]\s*(.+)$/.exec(line.trim());
          return match ? { term: match[1].trim(), definition: match[2].trim() } : { term: line.trim(), definition: '' };
        }).filter(item => item.term),
        constraints: $('brief-constraints').value.trim(),
        sourcePolicy: $('brief-policy').value.trim()
      };
      const empty = !value.purpose && !value.audience && !value.scope && !value.keyPoints.length && !value.terminology.length && !value.constraints && !value.sourcePolicy;
      await saveBrief(empty ? null : value);
    } catch (error) { button.disabled = false; app.toast(error.message, true); }
  };
}

async function openEvidence() {
  const current = doc();
  if (!current) { app.toast(t('请先新建或导入文档。')); return; }
  if (app.state.busy) { app.toast(t('请先停止生成任务，再检查依据。'), true); return; }
  await app.flushSave();
  try {
    const result = await app.api(`/api/documents/${current.id}/evidence`, { method: 'POST', body: { revision: current.revision } });
    current.evidence = { ...result.evidence, forRevision: result.forRevision };
    lastLedger = current.evidence; lastReport = null; view = 'evidence'; filter = 'all';
    showPanel('EVIDENCE LEDGER', '依据台账', '逐条核对正文说法与资料原文；只证明所给资料是否支持该说法。');
    renderEvidence();
    refreshIndicators();
  } catch (error) { app.toast(error.message, true); }
}

async function openDelivery() {
  const current = doc();
  if (!current) { app.toast(t('请先新建或导入文档。')); return; }
  if (app.state.busy) { app.toast(t('请先停止生成任务，再运行体检。'), true); return; }
  await app.flushSave();
  try {
    const result = await app.api(`/api/documents/${current.id}/delivery-check`, { method: 'POST', body: { revision: current.revision } });
    current.evidence = { ...result.evidence, forRevision: result.forRevision };
    current.delivery = { ...result.report, forRevision: result.forRevision };
    lastLedger = current.evidence; lastReport = current.delivery; view = 'delivery'; filter = 'all';
    showPanel('DELIVERY CHECK', '交付体检', '汇总结构、占位符、引用与依据覆盖；结论只覆盖已执行的检查。');
    renderDelivery();
    refreshIndicators();
  } catch (error) { app.toast(error.message, true); }
}

function showPanel(eyebrow, title, subtitle) {
  $('quality-eyebrow').textContent = eyebrow;
  $('quality-title').textContent = title;
  $('quality-subtitle').textContent = subtitle;
  $('quality-view').hidden = false;
  $('paper-scroll').hidden = true;
  $('studio-view').hidden = true;
  document.body.classList.remove('studio-open');
  // 窄屏下写作助手是覆盖式抽屉，会盖住检查结果；打开面板时先让位。
  document.body.classList.add('quality-open');
}

function staleBanner() {
  return uiHtml`<div class="quality-stale" role="status">${icon('clock')}<span>文档在检查之后有改动，以下结果已过期。</span><button class="secondary compact" id="quality-stale-refresh">重新检查</button></div>`;
}

function claimMatches(claim, key) {
  if (key === 'all') return true;
  if (key === 'supported') return ['supported', 'uncited'].includes(claim.status);
  if (key === 'weak') return ['weak', 'needs-check'].includes(claim.status);
  return claim.status === key;
}

function renderEvidence() {
  const ledger = lastLedger;
  if (!ledger) return;
  const s = ledger.summary;
  const filters = [
    ['all', `全部 ${s.total}`], ['supported', `已支持 ${s.supported + s.uncited}`],
    ['weak', `待确认 ${s.weak + s.needsCheck}`], ['unverified', `无依据 ${s.unverified}`], ['broken', `引用失效 ${s.broken}`]
  ];
  const claims = ledger.claims.map((claim, index) => ({ claim, index })).filter(item => claimMatches(item.claim, filter));
  const rows = claims.map(({ claim, index }) => {
    const status = CLAIM_STATUS[claim.status] || CLAIM_STATUS.unverified;
    const source = claim.source ? uiHtml`<div class="claim-source"><span>${e(claim.source.name)} · ${e(claim.source.location)}</span><span>${claim.source.coverage}% 重合</span></div><blockquote class="claim-quote">${e(claim.source.quote)}</blockquote>` : '';
    return uiHtml`<article class="claim-row" data-status="${e(claim.status)}"><div class="claim-head"><span class="status-pill" data-tone="${status.tone}">${e(status.label)}</span><span class="claim-id">${e(claim.id)}</span></div><p class="claim-text">${e(claim.text)}</p><p class="claim-note">${e(claim.note)}</p>${source}<button class="text-button claim-locate" data-locate-claim="${index}">${icon('search')}定位正文</button></article>`;
  }).join('');
  $('quality-content').innerHTML = uiHtml`${isStale(ledger) ? staleBanner() : ''}
    <div class="quality-summary">
      <div class="quality-stat"><strong>${s.total}</strong><span>关键说法</span></div>
      <div class="quality-stat"><strong>${s.coverage}%</strong><span>可核对覆盖</span></div>
      <div class="quality-stat"><strong>${s.unverified + s.weak + s.needsCheck}</strong><span>待补或待核</span></div>
      <div class="quality-stat"><strong>${s.broken}</strong><span>引用失效</span></div>
    </div>
    <div class="quality-toolbar"><div class="quality-filters">${filters.map(([key, label]) => `<button data-claim-filter="${key}" aria-pressed="${filter === key}" class="${filter === key ? 'selected' : ''}">${e(label)}</button>`).join('')}</div><button class="text-button" id="quality-copy">复制台账</button></div>
    <div class="claim-list">${rows || `<div class="quality-empty">${ledger.claims.length ? t('当前筛选下没有条目。') : t('正文中还没有可核对的关键说法。带数字、引用或事实性表述的句子会出现在这里。')}</div>`}</div>
    <p class="quality-note">${s.sources} 份启用资料 · ${ledger.claims.filter(claim => claim.citations.length).length} 条带引用标记 · 检查于 ${new Date(ledger.at).toLocaleString(language)}</p>
    <details class="quality-notes"><summary>检查范围与说明</summary><ul>${s.notes.map(note => `<li>${e(note)}</li>`).join('')}</ul></details>`;
}

function issueHtml(issue, index) {
  const canLocate = issue.evidence?.[0]?.quote || /第 \d+ 段/.test(issue.location || '');
  return uiHtml`<article class="issue-row" data-severity="${e(issue.severity)}"><div class="issue-head"><span class="severity-pill" data-tone="${issue.severity === 'blocker' ? 'bad' : issue.severity === 'warn' ? 'warn' : 'info'}">${e(issue.severityLabel)}</span><span class="issue-category">${e(ISSUE_CATEGORY[issue.category] || issue.category)}</span></div><h3>${e(issue.title)}</h3><p>${e(issue.detail)}</p><p class="issue-suggestion">建议：${e(issue.suggestion)}</p>${canLocate ? uiHtml`<button class="text-button claim-locate" data-locate-issue="${index}">${icon('search')}定位正文</button>` : ''}</article>`;
}

function renderDelivery() {
  const report = lastReport;
  if (!report) return;
  const grade = GRADE[report.grade] || GRADE.review;
  const groups = [
    ['blocker', '必须处理'], ['warn', '建议确认'], ['info', '提示']
  ].map(([severity, label]) => {
    const items = report.issues.map((issue, index) => ({ issue, index })).filter(item => item.issue.severity === severity);
    if (!items.length) return '';
    return `<section class="issue-group"><h3 class="issue-group-title">${label}<span>${items.length}</span></h3>${items.map(({ issue, index }) => issueHtml(issue, index)).join('')}</section>`;
  }).join('');
  $('quality-content').innerHTML = uiHtml`${isStale(report) ? staleBanner() : ''}
    <div class="grade-card" data-grade="${report.grade}">
      <div class="grade-score"><strong>${report.score}</strong><span>/ 100</span></div>
      <div class="grade-copy"><span class="quality-eyebrow">交付结论</span><h3>${e(grade.label)}</h3><p>${e(report.summary)}</p><div class="grade-counts"><span>必须处理 ${report.counts.blocker}</span><span>建议确认 ${report.counts.warn}</span><span>提示 ${report.counts.info}</span></div></div>
    </div>
    <div class="quality-summary">
      <div class="quality-stat"><strong>${report.stats.words.toLocaleString(language)}</strong><span>正文字数</span></div>
      <div class="quality-stat"><strong>${report.stats.headings}</strong><span>章节标题</span></div>
      <div class="quality-stat"><strong>${report.stats.citations}</strong><span>引用标记</span></div>
      <div class="quality-stat"><strong>${report.stats.evidenceCoverage}%</strong><span>依据覆盖</span></div>
    </div>
    ${groups || uiHtml('<div class="quality-empty">已执行的检查没有发现问题。仍请人工确认事实与版式。</div>')}
    <details class="quality-notes"><summary>检查范围与依据说明</summary><p>${e(report.scope)}</p><ul>${(report.evidence?.notes || []).map(note => `<li>${e(note)}</li>`).join('')}</ul></details>
    <p class="quality-note">检查于 ${new Date(report.at).toLocaleString(language)} · 得分仅反映已执行检查的严重程度，不代表内容真实或版式合格。</p>`;
}

function editorBlocks() {
  const editor = $('editor');
  const nodes = [];
  for (const child of editor.children) {
    if (['UL', 'OL'].includes(child.tagName)) nodes.push(...child.children);
    else if (child.tagName === 'DIV') nodes.push(...child.querySelectorAll('h2,h3,h4,p,li,blockquote,pre,table'));
    else if (/^(H[1-6]|P|BLOCKQUOTE|PRE|TABLE)$/.test(child.tagName)) nodes.push(child);
  }
  return nodes;
}

function plain(value) {
  return String(value || '').replace(/\s/g, '');
}

function flash(node) {
  // 定位要回到正文：质量面板此时占着正文区域，不收起就看不到高亮。
  $('quality-view').hidden = true;
  $('paper-scroll').hidden = false;
  document.body.classList.remove('quality-open');
  requestAnimationFrame(() => {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('claim-highlight');
    setTimeout(() => node.classList.remove('claim-highlight'), 2400);
  });
}

function locateText(text) {
  const needle = plain(text).slice(0, 16);
  if (!needle) return false;
  const blocks = editorBlocks();
  const hit = blocks.find(node => plain(node.textContent).includes(needle))
    || blocks.find(node => needle.length > 8 && plain(node.textContent).includes(needle.slice(0, 8)));
  if (!hit) return false;
  flash(hit); return true;
}

function locateParagraph(index) {
  const target = editorBlocks()[index];
  if (!target) return false;
  flash(target); return true;
}

function copyLedger() {
  const ledger = lastLedger;
  if (!ledger) return;
  const lines = [`依据台账 · ${doc()?.title || ''}`, `检查时间：${new Date(ledger.at).toLocaleString(language)}`, `可核对覆盖：${ledger.summary.coverage}%`, ''];
  for (const claim of ledger.claims) {
    const status = CLAIM_STATUS[claim.status]?.label || claim.status;
    lines.push(`[${claim.id}][${status}] ${claim.text}`);
    if (claim.source) lines.push(`  来源：${claim.source.name} · ${claim.source.location}`);
    if (claim.note) lines.push(`  说明：${claim.note}`);
  }
  lines.push('', ...ledger.summary.notes.map(note => `- ${note}`));
  navigator.clipboard.writeText(lines.join('\n')).then(() => app.toast(t('台账已复制'))).catch(() => app.toast(t('复制失败，请手动选择文本。'), true));
}

function sampleCount(html) {
  return (String(html || '').match(/<h[2-4]\b/gi) || []).length;
}

function wordCount(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/\s/g, '').length;
}

function openDistill() {
  if (app.state.busy) { app.toast(t('请先停止生成任务。'), true); return; }
  if (!app.state.documents.length) { app.toast(t('先创建或导入文档，作为提炼用的范文。'), true); return; }
  const rows = app.state.documents.map(current => uiHtml`<label class="sample-row"><input type="checkbox" data-sample value="${e(current.id)}"><span><strong>${e(current.title)}</strong><small>${sampleCount(current.html)} 个标题 · 约 ${wordCount(current.html).toLocaleString(language)} 字</small></span></label>`).join('');
  app.showModal('TEMPLATE DISTILLATION', uiHtml`<h2>从自己的范文提炼模板</h2><p class="modal-description">选择 1–5 篇结构稳定的文档。只提取章节顺序、常见表格列和术语，不复制正文；保存前可以核对。</p><label class="modal-label">模板名称（可留空自动命名）<input id="distill-title" maxlength="80" placeholder="例如：我的项目复盘模板"></label><div class="distill-samples">${rows}</div><p class="field-help">章节标题越一致，提炼结果越稳定。建议先用二级标题把范文分节。</p><p id="distill-error" class="inline-error" role="alert" hidden></p><div class="modal-choice"><button class="secondary" id="distill-cancel">取消</button><button class="primary" id="distill-run">开始提炼</button></div>`);
  $('distill-cancel').onclick = () => $('modal').close();
  $('distill-run').onclick = async () => {
    const ids = [...$('modal-body').querySelectorAll('[data-sample]:checked')].map(node => node.value);
    const error = $('distill-error');
    if (!ids.length) { error.textContent = t('至少选择一篇文档。'); error.hidden = false; return; }
    if (ids.length > 5) { error.textContent = t('一次最多选择五篇文档。'); error.hidden = false; return; }
    const button = $('distill-run'); button.disabled = true; button.textContent = t('正在提炼…'); error.hidden = true;
    try {
      await app.flushSave();
      const result = await app.api('/api/templates/distill', { method: 'POST', body: { documentIds: ids, title: $('distill-title').value.trim() } });
      previewDistill(result.template, result.confidence);
    } catch (failure) {
      button.disabled = false; button.textContent = t('开始提炼');
      error.textContent = failure.message; error.hidden = false;
    }
  };
}

function previewDistill(template, confidence) {
  const variables = (template.variables || []).slice(0, 12).map(item => `<span>${e(item.name)}</span>`).join('') || uiHtml('<span class="muted">未识别到表格列或字段</span>');
  app.showModal('TEMPLATE PREVIEW', uiHtml`<h2>核对提炼结果</h2><p class="modal-description">章节一致度约 ${confidence}%。确认章节、表格列和名称后保存；以后可从「我的模板」直接使用。</p><label class="modal-label">模板名称<input id="distill-save-title" maxlength="80" value="${e(template.title)}"></label><div class="distill-preview"><div><h3>章节顺序</h3><ol class="template-sections">${template.sections.map(section => `<li>${e(section)}</li>`).join('')}</ol></div><div><h3>常用列与字段</h3><div class="variable-chips">${variables}</div></div></div><details class="template-text-preview"><summary>查看生成的模板正文</summary><pre>${e(template.content)}</pre></details><p class="field-help">模板只保存在当前工作区，可随时删除。已提取的术语：${(template.origin?.terms || []).slice(0, 6).map(item => e(item.term)).join('、') || t('无')}。</p><p id="distill-error" class="inline-error" role="alert" hidden></p><div class="modal-choice"><button class="secondary" id="distill-back">重新选择</button><button class="primary" id="distill-save">保存为我的模板</button></div>`);
  $('distill-back').onclick = openDistill;
  $('distill-save').onclick = async () => {
    const title = $('distill-save-title').value.trim();
    const error = $('distill-error');
    if (!title) { error.textContent = t('请填写模板名称。'); error.hidden = false; return; }
    const button = $('distill-save'); button.disabled = true; button.textContent = t('正在保存…');
    try {
      const result = await app.api('/api/templates', { method: 'POST', body: { template: { ...template, title } } });
      app.state.templates = result.templates;
      app.state.category = '我的模板';
      app.state.templateFormat = 'all';
      app.state.templateLanguage = 'all';
      $('template-format').value = 'all';
      $('template-language').value = 'all';
      $('template-search').value = '';
      app.renderTemplates();
      $('modal').close();
      app.toast(t('已保存为我的模板'));
    } catch (failure) {
      button.disabled = false; button.textContent = t('保存为我的模板');
      error.textContent = failure.message; error.hidden = false;
    }
  };
}

function bind() {
  $('brief-button').onclick = () => { try { openBrief(); } catch (error) { app.toast(error.message, true); } };
  $('evidence-button').onclick = () => openEvidence().catch(error => app.toast(error.message, true));
  $('delivery-button').onclick = () => openDelivery().catch(error => app.toast(error.message, true));
  $('distill-template').onclick = openDistill;
  $('quality-close').onclick = reset;
  $('quality-refresh').onclick = () => (view === 'delivery' ? openDelivery() : openEvidence());
  $('quality-content').addEventListener('click', event => {
    if (event.target.closest('#quality-stale-refresh')) { (view === 'delivery' ? openDelivery() : openEvidence()); return; }
    const filterButton = event.target.closest('[data-claim-filter]');
    if (filterButton) { filter = filterButton.dataset.claimFilter; renderEvidence(); return; }
    if (event.target.closest('#quality-copy')) { copyLedger(); return; }
    const claimButton = event.target.closest('[data-locate-claim]');
    if (claimButton) {
      const claim = lastLedger?.claims[Number(claimButton.dataset.locateClaim)];
      if (!claim || !locateText(claim.plain)) app.toast(t('正文已修改，未找到这条说法。请重新检查依据。'), true);
      return;
    }
    const issueButton = event.target.closest('[data-locate-issue]');
    if (issueButton) {
      const issue = lastReport?.issues[Number(issueButton.dataset.locateIssue)];
      const quote = issue?.evidence?.[0]?.quote;
      const paragraph = /第 (\d+) 段/.exec(issue?.location || '');
      if (quote && locateText(quote)) return;
      if (paragraph && locateParagraph(Number(paragraph[1]) - 1)) return;
      app.toast(t('未能在正文中定位该问题，请根据说明手动查找。'), true);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('quality-view').hidden && $('modal').open === false) { reset(); }
  });
}

export function initQuality(options) {
  app = options;
  bind();
  refreshIndicators();
  return { reset, markStale: refreshIndicators, refreshIndicators, openBrief, openEvidence, openDelivery, openDistill };
}
