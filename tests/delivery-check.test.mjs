import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeliveryCheck } from '../lib/delivery-check.mjs';

const brief = {
  purpose: '支持季度经营决策', audience: '管理层', scope: '仅覆盖华东区', keyPoints: ['收入 120 万元'],
  terminology: [{ term: 'ARPU', definition: '单用户收入' }], constraints: '不超过 3 页', sourcePolicy: '只使用提供的资料',
  updatedAt: new Date().toISOString()
};

test('结构完整、引用可核对的文档视为未发现阻断项', () => {
  const document = {
    title: '季度经营分析',
    brief,
    sources: [{ id: 's1', name: '经营数据.md', text: '本季度收入 120 万元，同比增长 18%。ARPU 为 32 元。', enabled: true }],
    html: '<h2>一、经营概览</h2><p>本季度收入 120 万元[资料：经营数据.md]，同比增长 18%。</p><h2>二、下一步计划</h2><p>继续跟踪重点客户，ARPU 目标为 35 元。</p>'
  };
  const report = runDeliveryCheck({ document });
  assert.equal(report.grade, 'ready', JSON.stringify(report.issues));
  assert.equal(report.score, 100);
  assert.equal(report.counts.blocker, 0);
  assert.equal(report.stats.headings, 2);
  assert.match(report.scope, /不核对图片内容/);
});

test('占位符和失效引用是阻断项，并给出可定位的处理建议', () => {
  const document = {
    title: '待完善方案',
    sources: [{ id: 's1', name: '背景.md', text: '项目背景说明。', enabled: true }],
    html: '<h2>一、预算</h2><p>项目预算待补充，负责人待确认。</p><h2>二、依据</h2><p>根据调查，需求增长 20%[资料：不存在的报告.pdf]。</p>'
  };
  const report = runDeliveryCheck({ document });
  assert.equal(report.grade, 'blocked');
  assert.ok(report.counts.blocker >= 2);
  const placeholder = report.issues.find(issue => issue.category === 'placeholder');
  assert.match(placeholder.title, /待补充/);
  assert.match(placeholder.location, /第 \d+ 段/);
  const citation = report.issues.find(issue => issue.category === 'citation');
  assert.match(citation.detail, /不存在的报告/);
  assert.ok(report.issues.every(issue => issue.severityLabel));
});

test('空章节、表格列数不齐和依据不足进入建议确认', () => {
  const document = {
    title: '草稿',
    brief,
    sources: [{ id: 's1', name: '数据.md', text: '另一份资料的内容。', enabled: true }],
    html: '<h2>一、空章节</h2><h2>二、数据</h2><table><tr><th>项目</th><th>金额</th></tr><tr><td>收入</td></tr></table><p>市场占有率达到 45%，同比增长 9 个百分点。</p>'
  };
  const report = runDeliveryCheck({ document });
  assert.equal(report.grade, 'review');
  assert.ok(report.issues.some(issue => issue.title.includes('章节没有正文')));
  assert.ok(report.issues.some(issue => issue.category === 'table'));
  assert.ok(report.issues.some(issue => issue.category === 'evidence'));
  assert.ok(report.score < 100 && report.score > 0);
});

test('空文档直接阻断，简报缺失只作提示', () => {
  const empty = runDeliveryCheck({ document: { title: '空白', html: '<p></p>', sources: [] } });
  assert.equal(empty.grade, 'blocked');
  assert.ok(empty.issues.some(issue => issue.title === '正文内容过少'));
  assert.ok(empty.issues.some(issue => issue.category === 'brief' && issue.severity === 'info'));
  const briefOnly = runDeliveryCheck({ document: { title: '短文', html: '<p>这是一段已经写完但没有章节的正文，用于检查简报提示。</p>', sources: [], brief } });
  assert.ok(briefOnly.issues.every(issue => issue.category !== 'brief' || issue.severity === 'info'));
});
