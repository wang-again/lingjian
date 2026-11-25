import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionMap, sectionBody, replaceSectionBody, moveSection, removeSection, insertSection, sectionStats, sectionOutline } from '../lib/sections.mjs';

const REPORT = '<h1>区域复盘</h1><h2>一、项目概述</h2><p>本项目服务制造业客户。</p><h3>客户结构</h3><p>以大客户为主。</p><h2>二、实施计划</h2><p>分两期推进。</p><h2>三、风险与应对</h2><p></p>';

test('按二级标题切章，键值去掉中文编号后保持稳定', () => {
  const map = sectionMap(REPORT);
  assert.equal(map.level, 2);
  assert.deepEqual(map.sections.map(section => section.title), ['一、项目概述', '二、实施计划', '三、风险与应对']);
  assert.deepEqual(map.sections.map(section => section.key), ['h2:项目概述#1', 'h2:实施计划#1', 'h2:风险与应对#1']);
});

test('只有一个一级标题时把它当文档标题，改用二级切章；多个一级标题则按一级', () => {
  assert.equal(sectionMap('<h1>唯一标题</h1><p>正文</p><h2>甲</h2><p>a</p>').level, 2);
  assert.equal(sectionMap('<h1>第一部分</h1><p>a</p><h1>第二部分</h1><p>b</p>').level, 1);
  assert.deepEqual(sectionMap('<p>没有标题</p>').sections, []);
});

test('章节统计包含字数、子标题、空章节与引用标记', () => {
  const map = sectionMap(REPORT);
  assert.equal(map.sections[0].subheadings, 1);
  assert.ok(map.sections[0].words > 0);
  assert.equal(map.sections[2].empty, true);
  const stats = sectionStats(REPORT);
  assert.equal(stats.total, 3);
  assert.equal(stats.empty, 1);
  assert.equal(stats.filled, 2);
  assert.match(sectionOutline(REPORT), /1\. 一、项目概述/);
});

test('只替换目标章节正文，其他章节逐字节不变', () => {
  const key = sectionMap(REPORT).sections[1].key;
  const next = replaceSectionBody(REPORT, key, '<p>改为三期推进。</p>');
  assert.ok(next.includes('<h2>二、实施计划</h2><p>改为三期推进。</p>'));
  assert.ok(next.startsWith('<h1>区域复盘</h1><h2>一、项目概述</h2><p>本项目服务制造业客户。</p>'));
  assert.ok(next.endsWith('<h2>三、风险与应对</h2><p></p>'));
  assert.equal(sectionMap(next).sections.length, 3);
});

test('标题被改名后可按原标题回退定位，找不到时返回 null 而不是乱写', () => {
  const edited = REPORT.replace('二、实施计划', '二、实施安排');
  const key = 'h2:实施计划#1';
  assert.equal(sectionBody(REPORT, key), '<p>分两期推进。</p>');
  assert.equal(replaceSectionBody(edited, key, '<p>x</p>'), null);
  assert.equal(replaceSectionBody(edited, key, '<p>x</p>', '二、实施计划'), null);
  assert.equal(sectionMap(edited).sections[1].key, 'h2:实施安排#1');
});

test('移动章节整体交换标题与正文，边界不动时返回 null', () => {
  const sections = sectionMap(REPORT).sections;
  const next = moveSection(REPORT, sections[1].key, -1);
  assert.ok(next.indexOf('二、实施计划') < next.indexOf('一、项目概述'));
  assert.ok(next.includes('<h2>二、实施计划</h2><p>分两期推进。</p>'));
  const down = moveSection(REPORT, sections[1].key, 1);
  assert.ok(down.indexOf('三、风险与应对') < down.indexOf('二、实施计划'));
  assert.equal(moveSection(REPORT, sections[0].key, -1), null);
  assert.equal(moveSection(REPORT, sections[sections.length - 1].key, 1), null);
});

test('删除与插入章节都不影响其余章节内容', () => {
  const key = sectionMap(REPORT).sections[1].key;
  const removed = removeSection(REPORT, key);
  assert.ok(!removed.includes('实施计划'));
  assert.equal(sectionMap(removed).sections.length, 2);
  const inserted = insertSection(REPORT, { title: '四、附录', body: '<p>补充说明</p>' });
  assert.ok(inserted.endsWith('<h2>四、附录</h2><p>补充说明</p>'));
  const middle = insertSection(REPORT, { afterKey: sectionMap(REPORT).sections[0].key, title: '附：口径', body: '<p>口径说明</p>' });
  assert.ok(middle.indexOf('附：口径') < middle.indexOf('二、实施计划'));
  assert.ok(middle.indexOf('附：口径') > middle.indexOf('客户结构'));
  assert.throws(() => insertSection(REPORT, { title: '' }), /章节标题不能为空/);
});

test('没有标题的正文追加章节时不丢原文', () => {
  const next = insertSection('<p>自由写作的正文</p>', { title: '新增章节', body: '<p>内容</p>' });
  assert.ok(next.startsWith('<p>自由写作的正文</p>'));
  assert.match(next, /<h2>新增章节<\/h2>/);
});
