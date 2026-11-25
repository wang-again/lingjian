import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrief, briefGaps, briefPrompt, briefStats } from '../lib/document-brief.mjs';
import { buildMessages } from '../lib/prompts.mjs';

const document = {
  title: '季度经营分析',
  html: '<h2>一、经营概览</h2><p>本季度收入 120 万元。</p>',
  templateId: null,
  sources: [{ id: 's1', name: '财务数据.csv', text: '收入 120 万元', enabled: true }]
};

test('简报校验：去空白、保留有效字段、空对象视为未填写', () => {
  const brief = normalizeBrief({ purpose: '  支持季度经营决策  ', audience: '管理层', keyPoints: ['收入 120 万元', '  '], terminology: [{ term: 'ARPU', definition: '单用户收入' }, { term: '' }] });
  assert.equal(brief.purpose, '支持季度经营决策');
  assert.deepEqual(brief.keyPoints, ['收入 120 万元']);
  assert.deepEqual(brief.terminology, [{ term: 'ARPU', definition: '单用户收入' }]);
  assert.ok(Date.parse(brief.updatedAt));
  assert.equal(normalizeBrief({}), null);
  assert.equal(normalizeBrief(null), null);
  assert.equal(normalizeBrief({ purpose: '   ' }), null);
});

test('简报拒绝错误类型和超长内容', () => {
  assert.throws(() => normalizeBrief({ purpose: 42 }), /写作目的应为文字/);
  assert.throws(() => normalizeBrief({ purpose: '字'.repeat(501) }), /不能超过 500/);
  assert.throws(() => normalizeBrief({ keyPoints: '不是数组' }), /关键事实/);
  assert.throws(() => normalizeBrief({ terminology: new Array(31).fill({ term: 'a' }) }), /最多 30 项/);
});

test('简报缺口按重要性区分，提示词明确它只是任务约束', () => {
  assert.equal(briefGaps(null)[0].severity, 'normal');
  const gaps = briefGaps({ purpose: '决策', audience: '', scope: '', keyPoints: [], terminology: [], constraints: '', sourcePolicy: '' });
  assert.equal(gaps.find(item => item.field === 'audience').severity, 'important');
  assert.equal(gaps.find(item => item.field === 'scope').severity, 'normal');
  const prompt = briefPrompt({ purpose: '决策', audience: '管理层', keyPoints: ['收入 120 万元'], terminology: [{ term: 'ARPU', definition: '单用户收入' }], constraints: '不超过 3 页', sourcePolicy: '只使用提供的资料' });
  assert.match(prompt, /目标读者：管理层/);
  assert.match(prompt, /ARPU＝单用户收入/);
  assert.match(prompt, /不是资料证据/);
  assert.match(prompt, /不得自行补全/);
  assert.deepEqual(briefStats({ purpose: 'x', audience: 'y' }), { filled: 2, total: 7, percent: 29 });
});

test('写作消息同时把简报放进上下文与系统提示', () => {
  const brief = normalizeBrief({ purpose: '支持季度决策', audience: '管理层', constraints: '不超过 3 页' });
  const messages = buildMessages({ ...document, brief }, { mode: 'write', prompt: '撰写季度分析' });
  assert.match(messages[0].content, /文档简报/);
  assert.match(messages[0].content, /不超过 3 页/);
  const context = JSON.parse(messages[1].content);
  assert.equal(context.brief.purpose, '支持季度决策');
  assert.equal(context.sources.length, 1);
  const without = buildMessages(document, { mode: 'write', prompt: '撰写季度分析' });
  assert.ok(!without[0].content.includes('文档简报'));
  assert.ok(!('brief' in JSON.parse(without[1].content)));
});
