import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject, normalizeProjectSource, addProjectSources, searchProject, queryTerms, mergeSources, projectStats, PROJECT_LIMITS } from '../lib/projects.mjs';

const project = () => ({
  id: 'project-abc12345', name: '华东区项目', description: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  sources: [
    { id: 'ps-1', name: '经营数据.md', text: '本季度华东区收入 120 万元，同比增长 18%。客户主要集中在制造业。', addedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'ps-2', name: '会议纪要.txt', text: '需求变更需要每周确认一次，由张三负责同步。', addedAt: '2026-01-01T00:00:00.000Z' }
  ]
});

test('项目名称必填，id 带 project- 前缀，更新时保留创建时间', () => {
  assert.throws(() => normalizeProject({ name: '  ' }), /项目名称/);
  const created = normalizeProject({ name: '季度复盘', description: '华东区' });
  assert.match(created.id, /^project-/);
  assert.equal(created.sources.length, 0);
  const updated = normalizeProject({ name: '季度复盘（二）' }, created);
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.name, '季度复盘（二）');
});

test('项目资料校验长度与空内容，重复资料不重复入库', () => {
  assert.throws(() => normalizeProjectSource({ name: 'a', text: '   ' }), /不能为空/);
  assert.throws(() => normalizeProjectSource({ name: 'a', text: 'x'.repeat(PROJECT_LIMITS.sourceText + 1) }), /不能超过/);
  const once = addProjectSources({ ...project(), sources: [] }, [{ name: '经营数据.md', text: '收入 120 万元' }]);
  const twice = addProjectSources(once, [{ name: '经营数据.md', text: '收入 120 万元' }]);
  assert.equal(twice.sources.length, 1);
});

test('项目资料总量超限时拒绝，不静默截断', () => {
  const big = 'x'.repeat(PROJECT_LIMITS.sourceText);
  const filled = { ...project(), sources: Array.from({ length: 3 }, (_, index) => ({ id: `ps-${index}`, name: `资料 ${index}`, text: big, addedAt: '' })) };
  assert.throws(() => addProjectSources(filled, [{ name: '再加一份', text: big }]), /总量/);
});

test('中文按二元组、英文按词切分检索，命中带上下文', () => {
  assert.deepEqual(queryTerms('ARPU').includes('arpu'), true);
  assert.ok(queryTerms('华东区收入').includes('华东'));
  const result = searchProject(project(), '华东区收入');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].source.name, '经营数据.md');
  assert.ok(result.matches[0].snippet.includes('120 万元'));
  assert.ok(result.matches[0].score > 0);
  assert.equal(searchProject(project(), '不存在的词').matches.length, 0);
  assert.deepEqual(searchProject(project(), '  ').matches, []);
});

test('项目资料合并进文档资料：自有在前、同文去重、超出上限时按字符预算截断', () => {
  const own = [{ id: 's1', name: '自有资料.md', text: '自有内容', enabled: true }];
  const merged = mergeSources(own, project());
  assert.deepEqual(merged.map(item => item.name), ['自有资料.md', '经营数据.md', '会议纪要.txt']);
  assert.equal(merged[1].origin, 'project');
  assert.equal(merged[1].projectName, '华东区项目');
  const duplicated = mergeSources([{ id: 's1', name: '经营数据.md', text: project().sources[0].text.slice(0, 200), enabled: true }], project());
  assert.deepEqual(duplicated.map(item => item.name), ['经营数据.md', '会议纪要.txt']);
  const limited = mergeSources(own, project(), { limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(mergeSources([], null).length, 0);
});

test('项目统计给出资料数与字符数', () => {
  const stats = projectStats(project());
  assert.equal(stats.sources, 2);
  assert.ok(stats.chars > 30);
  assert.deepEqual(projectStats(null), { sources: 0, chars: 0, updatedAt: null });
});
