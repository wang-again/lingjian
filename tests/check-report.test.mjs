import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckReport } from '../lib/docx-inspection.mjs';
import { UserError } from '../lib/providers.mjs';

test('合法报告原样返回', () => {
  const report = { status: 'passed', stats: { paragraphs: 3 }, findings: [] };
  assert.deepEqual(parseCheckReport(JSON.stringify(report)), report);
});

test('脚本往 stdout 打了非 JSON 内容时返回 502，而不是让 JSON.parse 抛 500', () => {
  for (const stdout of ['module warning: fonts missing\n{"status":"passed"}', '', 'null', '[1,2]']) {
    assert.throws(
      () => parseCheckReport(stdout),
      error => error instanceof UserError && error.status === 502 && /无法解析/.test(error.message),
      `应拒绝 ${JSON.stringify(stdout)}`
    );
  }
});
