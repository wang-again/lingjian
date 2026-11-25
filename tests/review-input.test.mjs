import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewOperations } from '../lib/document-review.mjs';
import { UserError } from '../lib/providers.mjs';

const locations = new Map([
  ['doc.docx#p1', { location: 'doc.docx#p1', text: '第一段正文', paragraph_operations: ['insert_before', 'delete_paragraph'] }],
  ['doc.docx#t1', { location: 'doc.docx#t1', text: '表格行', cells: ['甲', '乙'], table_operations: ['insert_row_after', 'delete_row'] }]
]);
const base = { location: 'doc.docx#p1', find: '第一段正文', replace: '新的第一段', reason: '按要求修改' };

test('普通文字替换正常通过', () => {
  const [operation] = normalizeReviewOperations([{ ...base, type: 'replace_text' }], locations);
  assert.equal(operation.type, 'replace_text');
  assert.equal(operation.expected_matches, 1);
  assert.equal(operation.after_cells, null);
});

test('插入行的 replace 不是 JSON 时返回可读的 400，而不是 500', () => {
  assert.throws(
    () => normalizeReviewOperations([{ type: 'insert_row_after', location: 'doc.docx#t1', find: '表格行', replace: '不是数组', reason: '补充一行' }], locations),
    error => error instanceof UserError && error.status === 400 && /JSON 数组/.test(error.message)
  );
});

test('插入行的 replace 是 JSON 但不是文字数组时同样拒绝', () => {
  for (const bad of ['["甲",1]', '{"a":1}', 'null']) {
    assert.throws(
      () => normalizeReviewOperations([{ type: 'insert_row_after', location: 'doc.docx#t1', find: '表格行', replace: bad, reason: '补充一行' }], locations),
      error => error instanceof UserError && /文字数组/.test(error.message),
      `应拒绝 ${bad}`
    );
  }
});

test('合法的插入行参数解析为单元格数组供界面预览', () => {
  const [operation] = normalizeReviewOperations([{ type: 'insert_row_after', location: 'doc.docx#t1', find: '表格行', replace: '["丙","丁"]', reason: '补充一行' }], locations);
  assert.deepEqual(operation.after_cells, ['丙', '丁']);
  assert.deepEqual(operation.before_cells, ['甲', '乙']);
});
