import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatchAudit, auditDocument } from '../lib/batch-audit.mjs';

const clean = {
  id: 'doc-a', title: '季度复盘', revision: 4, sources: [{ id: 's1', name: '经营数据.md', text: '本季度收入 120 万元，同比增长 18%。', enabled: true }],
  html: '<h2>一、经营情况</h2><p>本季度收入 120 万元[资料：经营数据.md]，同比增长 18%[资料：经营数据.md]。</p><h2>二、下一步</h2><p>继续跟进制造业客户。</p>'
};
const messy = {
  id: 'doc-b', title: '项目申报', revision: 2, sources: [],
  html: '<h2>一、项目概述</h2><p>预算待补充。</p><p>预计收益 300 万元[资料：不存在的报告.pdf]。</p><h2>二、实施</h2><p></p>'
};

test('批量审计逐篇给出与单篇体检一致的等级与得分', () => {
  const single = auditDocument(clean);
  const report = runBatchAudit({ documents: [clean, messy] });
  assert.equal(report.count, 2);
  const row = report.rows.find(item => item.id === 'doc-a');
  assert.equal(row.score, single.score);
  assert.equal(row.grade, single.grade);
  assert.equal(row.sections.total, 2);
  assert.ok(row.citations >= 1);
  assert.equal(report.summary.byGrade.ready + report.summary.byGrade.review + report.summary.byGrade.blocked, 2);
});

test('批量审计汇总共同问题、低分文档与对比表', () => {
  const report = runBatchAudit({ documents: [clean, messy] });
  const blocked = report.rows.find(item => item.id === 'doc-b');
  assert.equal(blocked.grade, 'blocked');
  assert.ok(blocked.topIssues.some(issue => issue.category === 'citation'));
  assert.ok(report.summary.outliers.some(item => item.id === 'doc-b'));
  assert.equal(report.compare.rows.length, 2);
  assert.deepEqual(report.compare.metrics.map(item => item.key), ['words', 'sections', 'citations', 'coverage', 'blocker', 'warn', 'score']);
  assert.equal(report.compare.rows[1].values.score, blocked.score);
  assert.match(report.scope, /不做跨文档事实核对/);
});

test('共同问题只在两篇都出现时汇总', () => {
  const twin = { ...messy, id: 'doc-c', title: '项目申报（二）' };
  const report = runBatchAudit({ documents: [messy, twin] });
  assert.ok(report.summary.commonIssues.length >= 1);
  const issue = report.summary.commonIssues[0];
  assert.ok(issue.count >= 2);
  assert.equal(issue.documents.length, issue.count);
  const single = runBatchAudit({ documents: [clean, messy] });
  assert.equal(single.summary.commonIssues.length, 0);
});

test('按 id 过滤只审计选中文档，空选择直接报错', () => {
  const report = runBatchAudit({ documents: [clean, messy], ids: ['doc-b'] });
  assert.equal(report.count, 1);
  assert.equal(report.rows[0].id, 'doc-b');
  assert.throws(() => runBatchAudit({ documents: [] }), /没有选择/);
});

test('项目资料参与批量审计：绑定项目后引用可被核到', () => {
  const project = { id: 'project-1', name: '华东区', sources: [{ id: 'ps-1', name: '不存在的报告.pdf', text: '预计收益 300 万元', addedAt: '' }] };
  const bound = { ...messy, projectId: 'project-1' };
  const before = auditDocument(messy);
  const after = auditDocument(bound, { project });
  assert.equal(before.topIssues.some(issue => issue.category === 'citation'), true);
  assert.ok(after.sources.total > before.sources.total);
  assert.ok(after.coverage >= before.coverage);
  assert.notEqual(after.score, undefined);
});
