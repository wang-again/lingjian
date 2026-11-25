// 章节任务队列的数据层：任务是什么、怎么校验、怎么把结果写回正文。
// 队列只保存“要做什么”，执行在服务端逐条进行；同一篇文档同时只允许一个任务在跑，
// 避免两章同时替换正文时互相覆盖。

import { markdownToHtml, stripLeadingHeading } from './markdown.mjs';
import { replaceSectionBody, sectionMap, findSection } from './sections.mjs';

export const TASK_STATUS = ['queued', 'running', 'done', 'failed', 'skipped'];
export const TASK_KINDS = ['chapter', 'whole', 'check', 'evidence'];
const MAX_TASKS = 80;
const MAX_LOCKS = 200;

const text = (value, max) => String(value ?? '').trim().slice(0, max);

export function normalizeTask(input, { previous = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务格式不正确。');
  const kind = TASK_KINDS.includes(input.kind) ? input.kind : 'chapter';
  const title = text(input.title, 120);
  if (!title) throw new Error('请填写任务名称。');
  const instruction = text(input.instruction, 2000);
  const chapterKey = text(input.chapterKey, 200);
  const chapterTitle = text(input.chapterTitle, 200);
  if (kind === 'chapter' && !chapterKey && !chapterTitle) throw new Error('章节任务需要指定要写的章节。');
  const status = TASK_STATUS.includes(input.status) ? input.status : (previous?.status === 'running' ? 'running' : 'queued');
  return {
    id: /^task-[a-zA-Z0-9]{1,20}$/.test(String(input.id || '')) ? input.id : `task-${crypto.randomUUID().slice(0, 8)}`,
    kind, title, instruction, chapterKey, chapterTitle, status,
    recipeId: text(input.recipeId, 80), recipeName: text(input.recipeName, 120),
    createdAt: previous?.createdAt || new Date().toISOString(),
    startedAt: previous?.startedAt || null,
    finishedAt: previous?.finishedAt || null,
    message: text(input.message ?? previous?.message, 500),
    revisionBefore: Number.isSafeInteger(previous?.revisionBefore) ? previous.revisionBefore : null,
    revisionAfter: Number.isSafeInteger(previous?.revisionAfter) ? previous.revisionAfter : null
  };
}

export function normalizeTasks(value, previous = []) {
  if (!Array.isArray(value)) return Array.isArray(previous) ? previous.slice(0, MAX_TASKS) : [];
  const known = new Map((previous || []).map(task => [task.id, task]));
  return value.slice(0, MAX_TASKS).map(item => normalizeTask(item, { previous: known.get(item?.id) }));
}

// 锁定的章节不会被队列覆盖；键是章节 key，只保存布尔真值，避免脏数据长期堆积。
export function normalizeLocks(value, previous = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return previous && typeof previous === 'object' ? previous : {};
  const locks = {};
  for (const [key, locked] of Object.entries(value).slice(0, MAX_LOCKS)) {
    const name = text(key, 200);
    if (name && locked) locks[name] = true;
  }
  return locks;
}

export function taskCounts(tasks = []) {
  const counts = { total: tasks.length, queued: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const task of tasks) if (counts[task.status] !== undefined) counts[task.status]++;
  return counts;
}

export function nextQueued(tasks = []) {
  return tasks.find(task => task.status === 'queued') || null;
}

// 章节级写作：只把这一章（含标题）交给模型，避免它顺手改写别章。
export function scopedDocument(document, section) {
  const source = String(document.html || '');
  const heading = source.slice(section.start, section.bodyStart);
  return {
    ...document,
    html: `${heading}${source.slice(section.bodyStart, section.bodyEnd)}`,
    sources: Array.isArray(document.sources) ? document.sources : []
  };
}

export function chapterInstruction(section, request = '') {
  const specific = text(request, 1600) || '按文档简报、模板规范与已有小标题补全本章内容；数据不足处写“待补充”。';
  return `本次只写《${section.title}》这一章，不要写其他章节。\n${specific}`;
}

export function applyChapterResult(document, section, markdown) {
  const body = markdownToHtml(stripLeadingHeading(markdown, section.title));
  if (!body.trim()) throw new Error('模型没有返回可写入的正文。');
  const html = replaceSectionBody(document.html, section.key, body, section.title);
  if (html === null) throw new Error('章节标题已被修改，未能定位。请重新抓取章节后再执行。');
  return html;
}

export function applyWholeResult(document, markdown) {
  const html = markdownToHtml(stripLeadingHeading(markdown, document.title));
  if (!html.trim()) throw new Error('模型没有返回可写入的正文。');
  return html;
}

// 章节是否存在、是否被锁定：执行前的确定性校验，避免跑到一半才发现任务失效。
export function resolveTaskSection(document, task) {
  const map = sectionMap(document.html);
  const section = findSection(map, task.chapterKey, task.chapterTitle);
  if (!section) throw new Error(`没有找到章节「${task.chapterTitle || task.chapterKey}」。标题可能已修改，请重新抓取章节后再排任务。`);
  if (document.locks?.[section.key]) throw new Error(`章节「${section.title}」已锁定，先解锁再执行。`);
  return section;
}

export function taskLabel(task) {
  const kind = { chapter: '章节', whole: '整篇', check: '体检', evidence: '依据' }[task.kind] || '任务';
  return `${kind} · ${task.title}`;
}
