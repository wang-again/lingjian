import { language, t, uiHtml } from './i18n.js';
import { escapeHtml as e } from './editor.js';
import { createActivityTimeline, responseEvents } from './task-activity.js';

// 写作工作台：章节结构、任务队列、项目资料、批量审计与任务配方。
// 这里只做呈现与编排；章节解析、任务执行、审计结论都在服务端完成，前端不重复判断。

const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="/icon.svg#${name}"/></svg>`;

const TASK_STATUS = {
  queued: { label: t('待执行'), tone: 'info' },
  running: { label: t('执行中'), tone: 'warn' },
  done: { label: t('已完成'), tone: 'ok' },
  failed: { label: t('失败'), tone: 'bad' },
  skipped: { label: t('已跳过'), tone: '' }
};
const TASK_KIND = { chapter: t('章节'), whole: t('整篇'), check: t('体检'), evidence: t('依据') };
const GRADE = {
  ready: { label: t('可交付'), tone: 'ok' },
  review: { label: t('待确认'), tone: 'warn' },
  blocked: { label: t('需处理'), tone: 'bad' }
};
const TABS = [['chapters', t('章节与队列')], ['projects', t('项目资料')], ['audit', t('批量审计')], ['recipes', t('任务配方')]];

let app = null;
let tab = 'chapters';
let sections = [];
let level = 0;
let words = 0;
let locks = {};
let tasks = [];
let projects = [];
let recipes = [];
let audit = null;
let selectedSection = null;
let selectedProjectId = null;
let projectMatches = null;
let selectedIds = new Set();
let busy = false;
let activityTimeline;

const doc = () => app?.state.doc;
const scope = document => JSON.stringify([app.getOwner(), document.id]);

function setBadge(id, text, tone = '') {
  const node = $(id);
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || '';
  if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
}

function refreshBadge() {
  const counts = (doc()?.tasks || []).reduce((map, task) => { map[task.status] = (map[task.status] || 0) + 1; return map; }, {});
  if (counts.running) setBadge('studio-state', t('运行中'), 'warn');
  else if (counts.queued) setBadge('studio-state', `${counts.queued}`, 'warn');
  else setBadge('studio-state', '');
}

function reset() {
  const panel = $('studio-view');
  if (panel) panel.hidden = true;
  document.body.classList.remove('studio-open');
  const paper = $('paper-scroll');
  if (paper && $('quality-view')?.hidden !== false) paper.hidden = false;
  $('studio-content')?.replaceChildren();
  activityTimeline?.show(null);
  selectedIds = new Set();
  projectMatches = null;
  refreshBadge();
}

function showPanel() {
  $('studio-view').hidden = false;
  $('paper-scroll').hidden = true;
  $('quality-view').hidden = true;
  document.body.classList.remove('quality-open');
  // 窄屏下写作助手是覆盖式抽屉，会盖住工作台；打开面板时先让位。
  document.body.classList.add('studio-open');
}

async function load() {
  const current = doc();
  if (!current) return;
  await app.flushSave();
  const data = await app.api(`/api/documents/${current.id}/sections`);
  sections = data.sections || [];
  level = data.level || 0;
  words = data.words || 0;
  locks = data.locks || {};
  tasks = data.tasks || [];
  const bootstrap = await app.api('/api/bootstrap');
  projects = bootstrap.projects || [];
  recipes = bootstrap.recipes || [];
  audit = bootstrap.lastAudit || audit;
  app.state.projects = projects;
  app.state.recipes = recipes;
  if (!sections.some(section => section.key === selectedSection)) selectedSection = sections[0]?.key || null;
  if (!projects.some(project => project.id === selectedProjectId)) selectedProjectId = current.projectId || projects[0]?.id || null;
  if (!selectedIds.size) selectedIds = new Set(app.state.documents.map(item => item.id).slice(0, 20));
  render();
  refreshBadge();
}

async function open(nextTab = 'chapters') {
  if (!doc()) { app.toast(t('请先新建或导入文档。')); return; }
  tab = nextTab;
  showPanel();
  try { await load(); }
  catch (error) { app.toast(error.message, true); }
}

// —— 章节与队列 ——

function sectionRow(section, index) {
  const meta = [
    `${section.words.toLocaleString(language)} 字`,
    section.paragraphs ? `${section.paragraphs} 段` : '',
    section.tables ? `${section.tables} 个表格` : '',
    section.citations ? `${section.citations} 处引用` : '',
    section.placeholders ? `${section.placeholders} 处待补` : '',
    section.subheadings ? `${section.subheadings} 个小标题` : ''
  ].filter(Boolean).join(' · ');
  const locked = Boolean(locks[section.key]);
  return uiHtml`<article class="section-row ${section.key === selectedSection ? 'selected' : ''} ${section.empty ? 'is-empty' : ''}" data-section-row="${e(section.key)}">
    <div class="section-main">
      <button class="section-title" data-focus-section="${index}">${e(section.title || t('未命名章节'))}</button>
      <p class="section-meta">${e(meta)}</p>
    </div>
    <div class="section-tags">
      ${section.empty ? uiHtml('<span class="status-pill" data-tone="warn">空章节</span>') : ''}
      ${locked ? uiHtml('<span class="status-pill" data-tone="info">已锁定</span>') : ''}
      ${section.placeholders ? uiHtml`<span class="status-pill" data-tone="warn">待补 ${section.placeholders}</span>` : ''}
    </div>
    <div class="section-actions">
      <button class="icon-button" data-move-section="${index}" data-delta="-1" title="上移这一章" aria-label="上移">↑</button>
      <button class="icon-button" data-move-section="${index}" data-delta="1" title="下移这一章" aria-label="下移">↓</button>
      <button class="text-button" data-lock-section="${index}">${locked ? t('解锁') : t('锁定')}</button>
      <button class="text-button" data-fill-section="${index}">补全</button>
      <button class="icon-button" data-remove-section="${index}" title="删除这一章" aria-label="删除章节">${icon('trash')}</button>
    </div>
  </article>`;
}

function taskRow(task) {
  const status = TASK_STATUS[task.status] || TASK_STATUS.queued;
  const actions = [];
  if (task.status === 'queued') actions.push(uiHtml`<button class="text-button" data-run-task="${e(task.id)}">执行</button>`, uiHtml`<button class="text-button" data-skip-task="${e(task.id)}">跳过</button>`);
  if (task.status === 'failed') actions.push(uiHtml`<button class="text-button" data-run-task="${e(task.id)}">重试</button>`);
  if (task.status !== 'running') actions.push(uiHtml`<button class="text-button" data-delete-task="${e(task.id)}">删除</button>`);
  return `<article class="task-row" data-status="${e(task.status)}">
    <div class="task-head">
      <span class="status-pill" data-tone="${status.tone}">${status.label}</span>
      <strong>${e(task.title)}</strong>
      <span class="task-kind">${e(TASK_KIND[task.kind] || t('任务'))}</span>
      ${task.recipeName ? uiHtml`<span class="task-kind">配方 · ${e(task.recipeName)}</span>` : ''}
    </div>
    ${task.instruction ? `<p class="task-note">${e(task.instruction)}</p>` : ''}
    ${task.message ? `<p class="task-message">${e(task.message)}</p>` : ''}
    ${actions.length ? `<div class="task-actions">${actions.join('')}</div>` : ''}
  </article>`;
}

function renderChapters() {
  const counts = tasks.reduce((map, task) => { map[task.status] = (map[task.status] || 0) + 1; return map; }, {});
  const empty = sections.filter(section => section.empty).length;
  const locked = sections.filter(section => locks[section.key]).length;
  // 锁定的章节执行不了，批量补全时跳过，避免排进一条永远跑不动的任务。
  const fillable = sections.filter(section => section.empty && !locks[section.key]);
  const selected = sections.find(section => section.key === selectedSection);
  const queue = tasks.length
    ? tasks.map(taskRow).join('')
    : uiHtml`<div class="quality-empty">队列是空的。可以给某一章排一个写作任务，或直接核依据、跑体检。</div>`;

  $('studio-content').innerHTML = uiHtml`
    <div class="quality-summary studio-summary">
      <div class="quality-stat"><strong>${sections.length}</strong><span>章节</span></div>
      <div class="quality-stat"><strong>${empty}</strong><span>空章节</span></div>
      <div class="quality-stat"><strong>${locked}</strong><span>已锁定</span></div>
      <div class="quality-stat"><strong>${counts.queued || 0}</strong><span>待执行任务</span></div>
    </div>
    <div class="studio-toolbar">
      <button class="secondary compact" id="studio-add-section">${icon('plus')}新增章节</button>
      <button class="secondary compact" id="studio-fill-empty" ${fillable.length ? '' : 'disabled'} title="${empty && !fillable.length ? t('空章节都已锁定，先解锁再批量补全') : ''}">${icon('spark')}补全所有空章节</button>
      <span class="studio-hint">${selected ? t`当前选中：${e(selected.title)}` : t('点击章节标题可定位正文')}</span>
    </div>
    <div class="section-list">${sections.length ? sections.map(sectionRow).join('') : uiHtml`<div class="quality-empty">正文里还没有章节标题。先用工具栏插入标题，或新增一章。</div>`}</div>
    <div class="studio-queue">
      <div class="studio-subhead"><h3>任务队列</h3><span>${counts.queued || 0} 待执行 · ${counts.running || 0} 执行中 · ${counts.done || 0} 已完成${counts.failed ? t` · ${counts.failed} 失败` : ''}</span></div>
      <div class="studio-toolbar">
        <button class="secondary compact" data-add-task="whole">${icon('pen')}重写全文</button>
        <button class="secondary compact" data-add-task="evidence">${icon('list')}核依据</button>
        <button class="secondary compact" data-add-task="check">${icon('check')}交付体检</button>
        <button class="primary compact" id="studio-run-all" ${counts.queued ? '' : 'disabled'}>执行队列</button>
      </div>
      <div class="task-list">${queue}</div>
      <p class="quality-note">队列逐条执行，同一篇文档同时只跑一个任务；执行前会先保存正文，正文在期间被改动时任务退回队列，不会覆盖你的编辑。章节锁定后，针对该章的任务会停在队列里不执行。</p>
    </div>`;
}

// —— 项目资料 ——

function projectStats(project) {
  const chars = (project.sources || []).reduce((sum, source) => sum + source.text.length, 0);
  return `${(project.sources || []).length} 份资料 · ${chars.toLocaleString(language)} 字`;
}

function renderProjects() {
  const current = doc();
  const boundId = current?.projectId || null;
  const selected = projects.find(project => project.id === selectedProjectId) || null;
  const list = projects.length ? projects.map(project => `<button class="project-row ${project.id === selectedProjectId ? 'selected' : ''}" data-project="${e(project.id)}">
      <span class="project-row-main"><strong>${e(project.name)}</strong><small>${e(project.description || t('未填写说明'))}</small></span>
      <span class="project-row-meta">${e(projectStats(project))}</span>
      ${boundId === project.id ? uiHtml('<span class="status-pill" data-tone="ok">当前文档已绑定</span>') : ''}
    </button>`).join('') : uiHtml`<div class="quality-empty">还没有项目。建一个项目，把多篇文档共用的资料放进去，只需维护一份。</div>`;

  const sources = selected ? (selected.sources || []).map(source => uiHtml`<article class="source-row">
      <div class="source-main"><strong>${e(source.name)}</strong><span>${source.text.length.toLocaleString(language)} 字 · ${new Date(source.addedAt).toLocaleDateString(language)}</span></div>
      <button class="text-button" data-remove-project-source="${e(source.id)}">移除</button>
    </article>`).join('') : '';

  const matches = projectMatches ? uiHtml`<div class="project-matches">
      <p class="project-match-count">命中 ${projectMatches.total} 处${projectMatches.terms.length ? t`（检索词：${projectMatches.terms.map(term => e(term)).join('、')}）` : ''}</p>
      ${projectMatches.matches.map(match => `<article class="match-row"><strong>${e(match.source.name)}</strong><p>${e(match.snippet)}</p></article>`).join('') || uiHtml('<p class="quality-note">没有找到匹配内容。检索是字面匹配，适合查具体数字、名称与术语。</p>')}
    </div>` : '';

  $('studio-content').innerHTML = uiHtml`
    <div class="studio-toolbar">
      <label class="studio-field">项目名称<input id="project-name" maxlength="60" placeholder="例如：华东区季度复盘"></label>
      <label class="studio-field studio-field-wide">说明<input id="project-description" maxlength="500" placeholder="这个项目共用的资料范围"></label>
      <button class="primary compact" id="project-create">${icon('plus')}新建项目</button>
    </div>
    <div class="project-layout">
      <div class="project-list">${list}</div>
      <div class="project-detail">${selected ? uiHtml`
        <div class="project-detail-head"><div><h3>${e(selected.name)}</h3><p>${e(projectStats(selected))}${selected.description ? ` · ${e(selected.description)}` : ''}</p></div>
        <div class="project-detail-actions">
          <button class="secondary compact" id="project-bind" data-project-id="${e(selected.id)}">${boundId === selected.id ? t('已绑定当前文档') : t('绑定到当前文档')}</button>
          ${boundId === selected.id ? uiHtml('<button class="text-button" id="project-unbind">解除绑定</button>') : ''}
          <button class="text-button" id="project-delete" data-project-id="${e(selected.id)}">删除项目</button>
        </div></div>
        <div class="source-list">${sources || uiHtml('<p class="quality-note">这个项目还没有资料。资料会同时参与写作与依据核验。</p>')}</div>
        <div class="studio-form">
          <label class="studio-field">资料名称<input id="project-source-name" maxlength="120" placeholder="例如：经营数据.md"></label>
          <label class="studio-field studio-field-wide">资料正文<textarea id="project-source-text" rows="5" maxlength="200000" placeholder="粘贴要点、数据表或政策原文；单份最多 20 万字"></textarea></label>
          <div class="studio-form-actions">
            <label class="secondary compact file-label">${icon('upload')}读取文本文件<input type="file" id="project-source-file" accept=".txt,.md,.markdown,.csv,.tsv,.json" multiple hidden></label>
            <button class="secondary compact" id="project-source-add">加入项目资料</button>
          </div>
        </div>
        <div class="studio-form">
          <label class="studio-field studio-field-wide">在项目资料里查<input id="project-search" maxlength="200" placeholder="输入数字、名称或术语，例如：120 万元"></label>
          <button class="secondary compact" id="project-search-run">${icon('search')}检索</button>
        </div>
        ${matches}
      ` : uiHtml('<p class="quality-note">选择左侧项目查看资料；项目资料只在本机工作区保存。</p>')}</div>
    </div>
    <p class="quality-note">项目资料会以“已启用资料”的身份参与写作与依据核验，但不改动文档自己的参考资料列表。绑定关系随时可解除。</p>`;
}

// —— 批量审计 ——

function gradeBadge(grade) {
  const item = GRADE[grade] || GRADE.review;
  return `<span class="status-pill" data-tone="${item.tone}">${item.label}</span>`;
}

function renderAudit() {
  const documents = app.state.documents || [];
  const rowsById = new Map((audit?.rows || []).map(row => [row.id, row]));
  const checklist = documents.map(document => {
    const row = rowsById.get(document.id);
    return `<label class="audit-doc">
      <input type="checkbox" data-audit-doc="${e(document.id)}" ${selectedIds.has(document.id) ? 'checked' : ''}>
      <span class="audit-doc-title">${e(document.title)}</span>
      <small>${row ? t`${row.words.toLocaleString(language)} 字 · ${row.score} 分` : new Date(document.updatedAt).toLocaleDateString(language)}</small>
      ${row ? gradeBadge(row.grade) : ''}
    </label>`;
  }).join('');

  let report = uiHtml`<div class="quality-empty">还没有审计结果。勾选文档后运行一次，对比表会并列字数、章节、引用与依据覆盖。</div>`;
  if (audit) {
    const s = audit.summary;
    const metrics = audit.compare?.metrics || [];
    const head = uiHtml`<tr><th>文档</th><th>结论</th>${metrics.map(metric => `<th>${e(metric.label)}</th>`).join('')}<th>主要问题</th></tr>`;
    const body = (audit.compare?.rows || []).map(row => {
      const detail = (audit.rows || []).find(item => item.id === row.id);
      const issues = (detail?.topIssues || []).map(issue => e(issue.title)).join('；') || '—';
      return `<tr data-open-document="${e(row.id)}"><td><button class="text-button" data-open-document="${e(row.id)}">${e(row.title)}</button></td><td>${gradeBadge(row.grade)}</td>${metrics.map(metric => `<td>${e(String(row.values[metric.key] ?? '—'))}</td>`).join('')}<td class="audit-issue-cell">${issues}</td></tr>`;
    }).join('');
    const common = s.commonIssues?.length ? uiHtml`<div class="audit-common"><h3>多篇共有的问题</h3><ul>${s.commonIssues.map(issue => uiHtml`<li><span class="severity-pill" data-tone="${issue.severity === 'blocker' ? 'bad' : 'warn'}">${issue.severity === 'blocker' ? t('必须处理') : t('建议确认')}</span>${e(issue.title)}<small>${issue.count} 篇：${issue.documents.map(name => e(name)).join('、')}</small></li>`).join('')}</ul></div>` : '';
    const outliers = s.outliers?.length ? uiHtml`<p class="quality-note">明显落后：${s.outliers.map(row => t`${e(row.title)}（${row.score} 分）`).join('、')}。建议先处理这些文档的阻断项，再统一对比。</p>` : '';
    report = uiHtml`<div class="quality-summary">
        <div class="quality-stat"><strong>${audit.count}</strong><span>审计文档</span></div>
        <div class="quality-stat"><strong>${s.averageScore}</strong><span>平均分</span></div>
        <div class="quality-stat"><strong>${s.blockers}</strong><span>必须处理项</span></div>
        <div class="quality-stat"><strong>${s.byGrade.ready}</strong><span>可交付</span></div>
      </div>
      ${outliers}
      ${common}
      <div class="audit-table-wrap"><table class="audit-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      <p class="quality-note">${e(audit.scope)} 审计于 ${new Date(audit.at).toLocaleString(language)}。</p>`;
  }

  $('studio-content').innerHTML = uiHtml`
    <div class="studio-subhead"><h3>选择文档</h3><span>已选 ${selectedIds.size} 篇 · 单次最多 20 篇</span></div>
    <div class="audit-checklist">${checklist || uiHtml('<p class="quality-note">还没有文档。</p>')}</div>
    <div class="studio-toolbar">
      <button class="text-button" id="audit-select-all">全选</button>
      <button class="text-button" id="audit-select-none">清空</button>
      <button class="primary compact" id="audit-run" ${selectedIds.size ? '' : 'disabled'}>审计所选文档</button>
    </div>
    ${report}`;
}

// —— 任务配方 ——

function renderRecipes() {
  const list = recipes.map(recipe => uiHtml`<article class="recipe-card">
      <div class="recipe-head"><strong>${e(recipe.name)}</strong>${recipe.builtin ? uiHtml('<span class="status-pill" data-tone="info">内置</span>') : uiHtml('<span class="status-pill">我的</span>')}<span class="task-kind">${recipe.steps.length} 步</span></div>
      ${recipe.description ? `<p class="recipe-description">${e(recipe.description)}</p>` : ''}
      <p class="recipe-steps">${recipe.steps.map(step => `<span class="recipe-step">${e(TASK_KIND[step.kind] || step.kind)} · ${e(step.title)}</span>`).join('<span class="recipe-arrow">→</span>')}</p>
      <div class="task-actions">
        <button class="text-button" data-apply-recipe="${e(recipe.id)}">应用到当前文档</button>
        ${recipe.builtin ? '' : uiHtml`<button class="text-button" data-delete-recipe="${e(recipe.id)}">删除</button>`}
      </div>
    </article>`).join('');

  $('studio-content').innerHTML = uiHtml`
    <div class="studio-form">
      <label class="studio-field">配方名称<input id="recipe-name" maxlength="60" placeholder="例如：季度复盘标准流程"></label>
      <button class="secondary compact" id="recipe-save">把当前队列存为配方</button>
    </div>
    <p class="quality-note">配方只记录“要做什么”，应用时按当前文档的章节结构展开：空章节配方只排空章节，指定章节配方找不到时跳过，不会让整条队列失败。</p>
    <div class="recipe-list">${list || uiHtml('<div class="quality-empty">还没有配方。</div>')}</div>`;
}

function render() {
  $('studio-eyebrow').textContent = 'WRITING STUDIO';
  $('studio-title').textContent = ({ chapters: t('章节工作台'), projects: t('项目知识空间'), audit: t('批量审计与对比'), recipes: t('任务配方') })[tab];
  $('studio-subtitle').textContent = ({
    chapters: t`${doc()?.title || t('当前文档')} · ${words.toLocaleString(language)} 字 · ${sections.length} 章，可逐章写作、锁定与排队。`,
    projects: t('把多篇文档共用的资料放在项目里，一次维护、多篇引用。'),
    audit: t('对多篇文档跑同一套检查，用一张表找出差距与共性问题。'),
    recipes: t('常用写作顺序存成配方，一键排进任务队列。')
  })[tab];
  document.querySelectorAll('[data-studio-tab]').forEach(button => {
    const active = button.dataset.studioTab === tab;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-selected', String(active));
  });
  activityTimeline.show(tab === 'chapters' && doc() ? scope(doc()) : null);
  if (tab === 'chapters') renderChapters();
  else if (tab === 'projects') renderProjects();
  else if (tab === 'audit') renderAudit();
  else renderRecipes();
}

async function reload() {
  try { await load(); }
  catch (error) { app.toast(error.message, true); }
}

// —— 操作 ——

async function executeTask(document, taskId, activity) {
  const response = await app.api(`/api/documents/${document.id}/tasks/run`, {
    method: 'POST', accept: 'text/event-stream', raw: true,
    body: { revision: document.revision, providerId: app.state.activeProviderId, taskId }
  });
  let result;
  for await (const { kind, data } of responseEvents(response.body)) {
    if (kind === 'activity') activity.update(data);
    if (kind === 'done') result = data;
    if (kind === 'error') throw new Error(t(data.message));
  }
  if (!result) throw new Error(t('任务连接提前结束，请查看队列状态。'));
  if (doc() === document && result.document) {
    app.applyDocument(result.document);
    tasks = result.document.tasks || tasks;
    sections = result.sections || sections;
  }
  return result;
}

async function runTask(taskId) {
  if (busy) { app.toast(t('已有任务在执行，请稍候。')); return; }
  const current = doc();
  if (!current) return;
  busy = true;
  setBadge('studio-state', t('运行中'), 'warn');
  const activity = activityTimeline.start(scope(current));
  activity.record('提交队列任务');
  try {
    const result = await executeTask(current, taskId, activity);
    activity.finish('done');
    app.toast(result.task?.message || t('任务已完成'));
  } catch (error) {
    activity.finish('failed');
    app.toast(error.message, true);
  } finally {
    busy = false;
    await reload();
  }
}

async function runAll() {
  if (busy) { app.toast(t('已有任务在执行，请稍候。')); return; }
  const current = doc();
  if (!current) return;
  busy = true;
  let done = 0;
  let activity;
  try {
    for (let step = 0; step < 20; step++) {
      if (doc() !== current) break;
      const next = (current.tasks || []).find(task => task.status === 'queued');
      if (!next) break;
      activity ||= activityTimeline.start(scope(current));
      activity.record('提交队列任务', 'notice', { detail: next.title });
      const result = await executeTask(current, next.id, activity);
      if (result.task?.status !== 'done') break;
      done++;
    }
    activity?.finish(doc() === current ? 'done' : 'stopped');
    app.toast(done ? t`已执行 ${done} 个任务` : t('队列里没有待执行的任务'));
  } catch (error) {
    activity?.finish('failed');
    app.toast(error.message, true);
  } finally {
    busy = false;
    await reload();
  }
}

function taskModal(section) {
  const title = section?.title || '全文';
  app.showModal('TASK QUEUE', uiHtml`<h2>为「${e(title)}」排一个写作任务</h2><p class="modal-description">任务执行时只把这一章发给模型，其他章节不会被改动。锁定的章节会停在队列里。</p>
    <label class="modal-label">写作要求<textarea id="task-instruction" rows="4" maxlength="2000" placeholder="例如：补全三段实施计划，写明负责人与时间；缺少的数据写待补充">${section ? t('按文档简报、模板规范与已有小标题补全本章内容；数据不足处写“待补充”。') : t('按文档简报与模板规范重写全文，保留已有事实与数据。')}</textarea></label>
    <div class="modal-choice"><button class="secondary" id="task-cancel">取消</button><button class="secondary" id="task-queue">只加入队列</button><button class="primary" id="task-run">加入并执行</button></div>`);
  const close = () => $('modal').close();
  $('task-cancel').onclick = close;
  $('task-queue').onclick = async () => {
    const instruction = $('task-instruction').value.trim();
    const body = section
      ? { tasks: [{ kind: 'chapter', title: `补全 ${section.title}`, chapterKey: section.key, chapterTitle: section.title, instruction }] }
      : { tasks: [{ kind: 'whole', title: '重写全文', instruction }] };
    try {
      await app.api(`/api/documents/${doc().id}/tasks`, { method: 'POST', body });
      close();
      app.toast(t('已加入任务队列'));
      await reload();
    } catch (error) { app.toast(error.message, true); }
  };
  $('task-run').onclick = async () => {
    const instruction = $('task-instruction').value.trim();
    const body = section
      ? { tasks: [{ kind: 'chapter', title: `补全 ${section.title}`, chapterKey: section.key, chapterTitle: section.title, instruction }] }
      : { tasks: [{ kind: 'whole', title: '重写全文', instruction }] };
    try {
      const saved = await app.api(`/api/documents/${doc().id}/tasks`, { method: 'POST', body });
      close();
      const created = saved.tasks?.[saved.tasks.length - 1];
      await runTask(created?.id);
    } catch (error) { app.toast(error.message, true); }
  };
  $('task-instruction').focus();
}

function confirmModal(title, description, label, onConfirm) {
  app.showModal('PLEASE CONFIRM', uiHtml`<h2>${e(title)}</h2><p class="modal-description">${e(description)}</p><div class="modal-choice"><button class="secondary" id="confirm-cancel">取消</button><button class="primary" id="confirm-ok">${e(label)}</button></div>`);
  $('confirm-cancel').onclick = () => $('modal').close();
  $('confirm-ok').onclick = async () => {
    const button = $('confirm-ok'); button.disabled = true;
    try { await onConfirm(); $('modal').close(); }
    catch (error) { button.disabled = false; app.toast(error.message, true); }
  };
}

async function outline(op, payload = {}) {
  const current = doc();
  try {
    const result = await app.api(`/api/documents/${current.id}/outline`, { method: 'POST', body: { revision: current.revision, op, ...payload } });
    if (result.document) app.applyDocument(result.document);
    sections = result.sections || sections;
    app.toast(op === 'insert' ? t('已新增章节') : op === 'remove' ? t('已删除章节') : t('章节顺序已调整'));
    await reload();
  } catch (error) { app.toast(error.message, true); }
}

function focusSection(index) {
  const section = sections[index];
  if (!section) return;
  selectedSection = section.key;
  render();
  $('studio-view').hidden = true;
  $('paper-scroll').hidden = false;
  const headings = $('editor').querySelectorAll('h1,h2,h3,h4,h5,h6');
  const target = [...headings].find(heading => heading.textContent.trim() === section.title);
  if (!target) { app.toast(t('正文已修改，未找到这个标题。请刷新工作台。'), true); return; }
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.add('section-flash');
  setTimeout(() => target.classList.remove('section-flash'), 1800);
}

async function addProject() {
  const name = $('project-name').value.trim();
  if (!name) { app.toast(t('请填写项目名称。')); return; }
  try {
    const result = await app.api('/api/projects', { method: 'POST', body: { name, description: $('project-description').value.trim() } });
    projects = result.projects || [...projects, result.project];
    selectedProjectId = result.project.id;
    app.toast(t('项目已创建'));
    render();
  } catch (error) { app.toast(error.message, true); }
}

async function addProjectSources() {
  const selected = projects.find(project => project.id === selectedProjectId);
  if (!selected) return;
  const name = $('project-source-name').value.trim() || '未命名资料';
  const text = $('project-source-text').value.trim();
  if (!text) { app.toast(t('请粘贴资料正文，或读取一个文本文件。')); return; }
  try {
    const result = await app.api(`/api/projects/${selected.id}/sources`, { method: 'POST', body: { sources: [{ name, text }] } });
    projects = projects.map(project => project.id === selected.id ? result.project : project);
    projectMatches = null;
    app.toast(t`已加入「${name}」`);
    render();
  } catch (error) { app.toast(error.message, true); }
}

async function searchProject() {
  const selected = projects.find(project => project.id === selectedProjectId);
  if (!selected) return;
  const query = $('project-search').value.trim();
  if (!query) { app.toast(t('请填写要查的内容。')); return; }
  try {
    projectMatches = await app.api(`/api/projects/${selected.id}/search`, { method: 'POST', body: { query } });
    render();
  } catch (error) { app.toast(error.message, true); }
}

async function bindProject(projectId) {
  try {
    const result = await app.api(`/api/documents/${doc().id}/project`, { method: 'POST', body: { projectId } });
    if (result.document) app.applyDocument(result.document);
    app.toast(projectId ? t('已绑定项目资料，依据核验与写作都会带上') : t('已解除项目绑定'));
    await reload();
  } catch (error) { app.toast(error.message, true); }
}

async function runAudit() {
  if (!selectedIds.size) { app.toast(t('请先勾选要审计的文档。')); return; }
  const button = $('audit-run');
  if (button) button.disabled = true;
  try {
    const result = await app.api('/api/batch-audit', { method: 'POST', body: { ids: [...selectedIds] } });
    audit = result.report;
    app.state.lastAudit = audit;
    render();
    app.toast(t`已审计 ${audit.count} 篇文档，平均 ${audit.summary.averageScore} 分`);
  } catch (error) { app.toast(error.message, true); if (button) button.disabled = false; }
}

async function saveRecipe() {
  const name = $('recipe-name').value.trim();
  if (!name) { app.toast(t('请填写配方名称。')); return; }
  try {
    const result = await app.api('/api/recipes', { method: 'POST', body: { fromDocumentId: doc().id, name } });
    recipes = result.recipes || [...recipes, result.recipe];
    app.toast(t`已保存配方「${name}」`);
    render();
  } catch (error) { app.toast(error.message, true); }
}

async function applyRecipe(recipeId) {
  try {
    const result = await app.api(`/api/recipes/${recipeId}/apply`, { method: 'POST', body: { documentId: doc().id } });
    tab = 'chapters';
    app.toast(t`已排入 ${result.added} 个任务`);
    await reload();
  } catch (error) { app.toast(error.message, true); }
}

async function deleteRecipe(recipeId) {
  try {
    const result = await app.api(`/api/recipes/${recipeId}`, { method: 'DELETE' });
    recipes = result.recipes || recipes.filter(recipe => recipe.id !== recipeId);
    render();
    app.toast(t('配方已删除'));
  } catch (error) { app.toast(error.message, true); }
}

// —— 事件绑定 ——

function bind() {
  $('studio-button').onclick = () => open('chapters').catch(error => app.toast(error.message, true));
  $('studio-close').onclick = reset;
  $('studio-refresh').onclick = () => reload();
  $('studio-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-studio-tab]');
    if (!button) return;
    tab = button.dataset.studioTab;
    if (tab === 'audit' && !selectedIds.size) selectedIds = new Set((app.state.documents || []).map(item => item.id).slice(0, 20));
    $('studio-view').scrollTop = 0;
    render();
  });

  $('studio-content').addEventListener('click', event => {
    const sectionButton = event.target.closest('[data-focus-section]');
    if (sectionButton) { focusSection(Number(sectionButton.dataset.focusSection)); return; }
    const moveButton = event.target.closest('[data-move-section]');
    if (moveButton) { const section = sections[Number(moveButton.dataset.moveSection)]; if (section) outline('move', { key: section.key, delta: Number(moveButton.dataset.delta) }); return; }
    const lockButton = event.target.closest('[data-lock-section]');
    if (lockButton) {
      const section = sections[Number(lockButton.dataset.lockSection)];
      if (!section) return;
      const next = { ...locks };
      if (next[section.key]) delete next[section.key]; else next[section.key] = true;
      app.api(`/api/documents/${doc().id}/locks`, { method: 'PUT', body: { locks: next } })
        .then(result => { locks = result.locks || {}; render(); app.toast(next[section.key] ? t`已锁定「${section.title}」` : t`已解锁「${section.title}」`); })
        .catch(error => app.toast(error.message, true));
      return;
    }
    const fillButton = event.target.closest('[data-fill-section]');
    if (fillButton) { selectedSection = sections[Number(fillButton.dataset.fillSection)]?.key || selectedSection; taskModal(sections[Number(fillButton.dataset.fillSection)]); return; }
    const removeButton = event.target.closest('[data-remove-section]');
    if (removeButton) {
      const section = sections[Number(removeButton.dataset.removeSection)];
      if (section) confirmModal(`删除「${section.title}」？`, '这一章的标题与正文会从文档中移除；针对它的排队任务也会一并清理。正文其余部分不受影响。', '删除这一章', () => outline('remove', { key: section.key }));
      return;
    }
    if (event.target.closest('#studio-add-section')) {
      app.showModal('NEW SECTION', uiHtml`<h2>新增一章</h2><p class="modal-description">新章节会插在选中章节之后；没有选中时追加到文末。</p><label class="modal-label">章节标题<input id="new-section-title" maxlength="100" placeholder="例如：四、风险与应对"></label><div class="modal-choice"><button class="secondary" id="new-section-cancel">取消</button><button class="primary" id="new-section-ok">新增</button></div>`);
      $('new-section-cancel').onclick = () => $('modal').close();
      $('new-section-ok').onclick = async () => {
        const title = $('new-section-title').value.trim();
        if (!title) { app.toast(t('请填写章节标题。')); return; }
        await outline('insert', { title, afterKey: selectedSection || '' });
        $('modal').close();
      };
      $('new-section-title').focus();
      return;
    }
    if (event.target.closest('#studio-fill-empty')) {
      const empty = sections.filter(section => section.empty && !locks[section.key]);
      const lockedEmpty = sections.filter(section => section.empty && locks[section.key]);
      if (!empty.length) { app.toast(lockedEmpty.length ? t('空章节都已锁定，先解锁再批量补全。') : t('没有需要补全的空章节。')); return; }
      app.api(`/api/documents/${doc().id}/tasks`, { method: 'POST', body: { tasks: empty.map(section => ({ kind: 'chapter', title: `补全 ${section.title}`, chapterKey: section.key, chapterTitle: section.title, instruction: '按文档简报与本章标题补全内容；缺少的数据写“待补充”，不虚构。' })) } })
        .then(() => { app.toast(t`已为空章节排 ${empty.length} 个任务${lockedEmpty.length ? t`，跳过 ${lockedEmpty.length} 个锁定章节` : ''}`); return reload(); })
        .catch(error => app.toast(error.message, true));
      return;
    }
    const addTask = event.target.closest('[data-add-task]');
    if (addTask) {
      const kind = addTask.dataset.addTask;
      if (kind === 'whole') { taskModal(null); return; }
      app.api(`/api/documents/${doc().id}/tasks`, { method: 'POST', body: { tasks: [{ kind, title: kind === 'check' ? '交付体检' : '核依据' }] } })
        .then(() => { app.toast(kind === 'check' ? t('已排入交付体检') : t('已排入依据核验')); return reload(); })
        .catch(error => app.toast(error.message, true));
      return;
    }
    if (event.target.closest('#studio-run-all')) { runAll(); return; }
    const runButton = event.target.closest('[data-run-task]');
    if (runButton) { runTask(runButton.dataset.runTask); return; }
    const skipButton = event.target.closest('[data-skip-task]');
    if (skipButton) {
      app.api(`/api/documents/${doc().id}/tasks/${skipButton.dataset.skipTask}`, { method: 'PATCH', body: { status: 'skipped' } })
        .then(result => { tasks = result.tasks || tasks; render(); app.toast(t('任务已跳过')); })
        .catch(error => app.toast(error.message, true));
      return;
    }
    const deleteButton = event.target.closest('[data-delete-task]');
    if (deleteButton) {
      app.api(`/api/documents/${doc().id}/tasks/${deleteButton.dataset.deleteTask}`, { method: 'DELETE' })
        .then(result => { tasks = result.tasks || tasks; render(); refreshBadge(); })
        .catch(error => app.toast(error.message, true));
      return;
    }

    // 项目
    const projectButton = event.target.closest('[data-project]');
    if (projectButton) { selectedProjectId = projectButton.dataset.project; projectMatches = null; render(); return; }
    if (event.target.closest('#project-create')) { addProject(); return; }
    if (event.target.closest('#project-source-add')) { addProjectSources(); return; }
    if (event.target.closest('#project-search-run')) { searchProject(); return; }
    if (event.target.closest('#project-bind')) { bindProject(selectedProjectId); return; }
    if (event.target.closest('#project-unbind')) { bindProject(null); return; }
    const removeSource = event.target.closest('[data-remove-project-source]');
    if (removeSource) {
      const selected = projects.find(project => project.id === selectedProjectId);
      if (!selected) return;
      app.api(`/api/projects/${selected.id}/sources/${removeSource.dataset.removeProjectSource}`, { method: 'DELETE' })
        .then(result => { projects = projects.map(project => project.id === selected.id ? result.project : project); render(); })
        .catch(error => app.toast(error.message, true));
      return;
    }
    const deleteProject = event.target.closest('#project-delete');
    if (deleteProject) {
      const selected = projects.find(project => project.id === deleteProject.dataset.projectId);
      if (!selected) return;
      confirmModal(`删除项目「${selected.name}」？`, '项目资料会被删除，已绑定的文档会自动解绑，文档正文与文档自己的参考资料保留。', '删除项目', async () => {
        const result = await app.api(`/api/projects/${selected.id}`, { method: 'DELETE' });
        projects = result.projects || projects.filter(project => project.id !== selected.id);
        selectedProjectId = projects[0]?.id || null;
        await reload();
      });
      return;
    }

    // 审计
    if (event.target.closest('#audit-select-all')) { selectedIds = new Set((app.state.documents || []).map(item => item.id).slice(0, 20)); render(); return; }
    if (event.target.closest('#audit-select-none')) { selectedIds = new Set(); render(); return; }
    if (event.target.closest('#audit-run')) { runAudit(); return; }
    const openDocument = event.target.closest('[data-open-document]');
    if (openDocument) {
      const id = openDocument.dataset.openDocument;
      reset();
      app.selectDocument(id).catch(error => app.toast(error.message, true));
      return;
    }

    // 配方
    if (event.target.closest('#recipe-save')) { saveRecipe(); return; }
    const applyButton = event.target.closest('[data-apply-recipe]');
    if (applyButton) { applyRecipe(applyButton.dataset.applyRecipe); return; }
    const deleteRecipeButton = event.target.closest('[data-delete-recipe]');
    if (deleteRecipeButton) { deleteRecipe(deleteRecipeButton.dataset.deleteRecipe); return; }
  });

  $('studio-content').addEventListener('change', async event => {
    const checkbox = event.target.closest('[data-audit-doc]');
    if (checkbox) {
      if (checkbox.checked) selectedIds.add(checkbox.dataset.auditDoc); else selectedIds.delete(checkbox.dataset.auditDoc);
      const button = $('audit-run');
      if (button) button.disabled = !selectedIds.size;
      const counter = $('studio-content').querySelector('.studio-subhead span');
      if (counter) counter.textContent = t`已选 ${selectedIds.size} 篇 · 单次最多 20 篇`;
      return;
    }
    const fileInput = event.target.closest('#project-source-file');
    if (!fileInput || !fileInput.files?.length) return;
    const files = [...fileInput.files].slice(0, 5);
    const parts = [];
    for (const file of files) {
      if (file.size > 1_000_000) { app.toast(t`「${file.name}」超过 1MB，请先在文件处理里提取文本。`, true); return; }
      try { parts.push(`【${file.name}】\n${await file.text()}`); }
      catch { app.toast(t`无法读取「${file.name}」。`, true); return; }
    }
    $('project-source-name').value = files[0].name;
    $('project-source-text').value = parts.join('\n\n');
    app.toast(t`已读入 ${files.length} 个文本文件，确认后加入项目`);
  });

  $('studio-content').addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.id === 'project-search') { event.preventDefault(); searchProject(); }
    if (event.key === 'Enter' && event.target.id === 'recipe-name') { event.preventDefault(); saveRecipe(); }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('studio-view').hidden && $('modal').open === false) reset();
  });
}

export function initStudio(options) {
  app = options;
  activityTimeline = createActivityTimeline($('studio-activity'));
  bind();
  return { open, reset, refreshBadge, get busy() { return busy; } };
}
