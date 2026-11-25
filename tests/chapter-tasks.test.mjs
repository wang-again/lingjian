import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTask, normalizeTasks, normalizeLocks, nextQueued, taskCounts, scopedDocument, chapterInstruction, applyChapterResult, applyWholeResult, resolveTaskSection, taskLabel } from '../lib/chapter-tasks.mjs';
import { sectionMap } from '../lib/sections.mjs';

const HTML = '<h1>报告</h1><h2>一、背景</h2><p>已有背景。</p><h2>二、方案</h2><p></p>';
const DOCUMENT = { id: 'doc-1', title: '报告', html: HTML, sources: [], revision: 3, locks: {} };

test('任务校验：名称与章节必填，缺省状态为排队', () => {
  assert.throws(() => normalizeTask({ kind: 'chapter', chapterKey: 'k' }), /任务名称/);
  assert.throws(() => normalizeTask({ kind: 'chapter', title: '写背景' }), /指定要写的章节/);
  const task = normalizeTask({ kind: 'chapter', title: '写背景', chapterKey: 'h2:背景#1' });
  assert.match(task.id, /^task-/);
  assert.equal(task.status, 'queued');
  assert.equal(task.instruction, '');
  // 整篇与体检任务不需要章节。
  assert.equal(normalizeTask({ kind: 'check', title: '体检' }).chapterKey, '');
});

test('任务列表上限 80 条，并保留同 id 任务的执行状态', () => {
  const previous = [normalizeTask({ kind: 'chapter', title: '写背景', chapterKey: 'k', id: 'task-abc12345' })];
  previous[0].status = 'done';
  const next = normalizeTasks([{ ...previous[0] }], previous);
  assert.equal(next[0].status, 'done');
  const many = Array.from({ length: 100 }, (_, index) => ({ kind: 'check', title: `体检 ${index}` }));
  assert.equal(normalizeTasks(many).length, 80);
});

test('锁定只保存真值，脏数据不会长期堆积', () => {
  assert.deepEqual(normalizeLocks({ 'h2:背景#1': true, 'h2:方案#1': false, '': true }), { 'h2:背景#1': true });
  assert.deepEqual(normalizeLocks(null, { a: true }), { a: true });
  assert.deepEqual(normalizeLocks([1, 2]), {});
});

test('章节任务只把这一章交给模型，并写明只写本章', () => {
  const section = sectionMap(HTML).sections[1];
  const scoped = scopedDocument(DOCUMENT, section);
  assert.ok(scoped.html.includes('<h2>二、方案</h2>'));
  assert.ok(!scoped.html.includes('已有背景'));
  assert.ok(chapterInstruction(section, '补两个实施方案').includes('只写《二、方案》这一章'));
  assert.ok(chapterInstruction(section, '补两个实施方案').includes('补两个实施方案'));
});

test('写回结果只替换目标章节，并剥掉模型重复输出的章节标题', () => {
  const section = sectionMap(HTML).sections[1];
  const html = applyChapterResult(DOCUMENT, section, '## 二、方案\n\n这里有新内容。\n\n- 第一步\n- 第二步');
  assert.ok(html.includes('<h2>二、方案</h2><p>这里有新内容。</p><ul><li>第一步</li><li>第二步</li></ul>'));
  assert.equal((html.match(/二、方案/g) || []).length, 1);
  assert.ok(html.includes('已有背景'));
  assert.throws(() => applyChapterResult(DOCUMENT, section, '   '), /没有返回/);
});

test('整篇结果保留标题层级并拒绝空输出', () => {
  const html = applyWholeResult({ title: '报告' }, '# 报告\n\n正文一段。');
  assert.equal(html, '<p>正文一段。</p>');
  assert.throws(() => applyWholeResult({ title: '报告' }, ''), /没有返回/);
});

test('锁定章节与失效章节在执行前就被拒绝', () => {
  const section = sectionMap(HTML).sections[1];
  assert.equal(resolveTaskSection(DOCUMENT, { chapterKey: section.key }).title, '二、方案');
  assert.throws(() => resolveTaskSection({ ...DOCUMENT, locks: { [section.key]: true } }, { chapterKey: section.key }), /已锁定/);
  assert.throws(() => resolveTaskSection(DOCUMENT, { chapterKey: 'h2:不存在#1', chapterTitle: '不存在' }), /没有找到章节/);
});

test('队列计数与下一条任务', () => {
  const tasks = [
    { id: 'task-1', status: 'done' }, { id: 'task-2', status: 'queued' }, { id: 'task-3', status: 'failed' }
  ];
  assert.equal(nextQueued(tasks).id, 'task-2');
  assert.deepEqual(taskCounts(tasks), { total: 3, queued: 1, running: 0, done: 1, failed: 1, skipped: 0 });
  assert.equal(taskLabel({ kind: 'chapter', title: '写背景' }), '章节 · 写背景');
});
