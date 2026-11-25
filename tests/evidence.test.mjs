import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceLedger, extractClaims, locateAnchor } from '../lib/evidence.mjs';

const source = (overrides = {}) => ({ id: 's1', name: '经营数据.md', text: '本季度收入 120 万元，同比增长 18%。重点项目由张三月度跟进。', enabled: true, ...overrides });

test('引用且逐字匹配时标记为已支持，并给出原文位置', () => {
  const ledger = buildEvidenceLedger({
    html: '<h2>一、经营情况</h2><p>本季度收入 120 万元[资料：经营数据.md]。</p>',
    sources: [source()]
  });
  const claim = ledger.claims.find(item => item.plain.includes('本季度收入'));
  assert.equal(claim.status, 'supported');
  assert.equal(claim.source.name, '经营数据.md');
  assert.match(claim.source.quote, /本季度收入 120 万元/);
  assert.match(claim.source.location, /第 1 段/);
  assert.equal(ledger.summary.supported, 1);
  assert.equal(ledger.summary.coverage, 100);
});

test('找到原文但没写引用时提示补充引用', () => {
  const ledger = buildEvidenceLedger({ html: '<p>本季度收入 120 万元，同比增长 18%。</p>', sources: [source()] });
  const claim = ledger.claims[0];
  assert.equal(claim.status, 'uncited');
  assert.match(claim.note, /建议补上/);
  assert.equal(ledger.summary.uncited, 1);
});

test('英文引用保留文件名并能核对原文', () => {
  const ledger = buildEvidenceLedger({
    html: '<p>The project budget is 1,200 dollars [Source: budget.txt].</p>',
    sources: [source({ name: 'budget.txt', text: 'The project budget is 1,200 dollars.' })]
  });
  assert.equal(ledger.claims[0].status, 'supported');
  assert.equal(ledger.claims[0].source.name, 'budget.txt');
  assert.equal(ledger.summary.withCitations, 1);
});

test('引用不存在或已停用的资料时标记为阻断', () => {
  const missing = buildEvidenceLedger({ html: '<p>收入达到 120 万元[资料：不存在的文件.docx]。</p>', sources: [source()] });
  assert.equal(missing.claims[0].status, 'broken');
  assert.match(missing.claims[0].note, /不在当前资料列表/);
  const disabled = buildEvidenceLedger({ html: '<p>收入达到 120 万元[资料：经营数据.md]。</p>', sources: [source({ enabled: false })] });
  assert.equal(disabled.claims[0].status, 'broken');
  assert.match(disabled.claims[0].note, /已停用/);
  assert.ok(disabled.summary.notes.some(note => note.includes('未启用参考资料')));
});

test('没有资料时不做假验证，数字缺失会单独提示', () => {
  const none = buildEvidenceLedger({ html: '<p>本季度收入 120 万元，同比增长 18%。</p>', sources: [] });
  assert.equal(none.claims[0].status, 'unverified');
  assert.equal(none.summary.coverage, 0);
  const mismatch = buildEvidenceLedger({ html: '<p>项目在 2026 年 3 月启动，预算 120 万元。</p>', sources: [{ id: 's2', name: '计划.md', text: '项目在 2026 年 3 月启动，预算 150 万元。' }] });
  const claim = mismatch.claims[0];
  assert.ok(['uncited', 'supported'].includes(claim.status));
  assert.match(claim.note, /120/);
  assert.deepEqual(claim.numbers.missing, ['120']);
});

test('只提取带数字、引用或事实性表述的句子，并给出稳定锚点', () => {
  const html = '<h2>一、背景</h2><p>这是一个普通段落。</p><p>市场占有率达到 35%，同比提升 4 个百分点。</p><p>团队需要继续努力。</p>';
  const claims = extractClaims(html);
  assert.equal(claims.length, 1, '普通叙述和主观表态不应进入台账');
  assert.match(claims[0].plain, /35%/);
  assert.equal(claims[0].blockTag, 'p');
  const index = locateAnchor(html, claims[0].anchor);
  assert.equal(index, claims[0].blockIndex);
  assert.equal(locateAnchor(html, { blockHash: 'deadbeef0000' }), -1);
});
