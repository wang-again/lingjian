import test from 'node:test';
import assert from 'node:assert/strict';
import { compactToolHistory, CONTEXT_CHAR_BUDGET, COMPACTED_OUTPUT } from '../lib/office-agent.mjs';

const big = size => JSON.stringify({ text: 'x'.repeat(size) });

test('累计工具输出超过预算时压缩较早结果，保留最近三条原文', () => {
  const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: big(1000) }];
  for (let i = 0; i < 8; i++) messages.push({ role: 'tool', tool_call_id: `c${i}`, content: big(30_000) });

  const result = compactToolHistory(messages);
  assert.ok(result.compacted > 0, '应发生压缩');
  assert.ok(result.length <= CONTEXT_CHAR_BUDGET, `压缩后仍超预算：${result.length}`);

  const toolMessages = messages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.at(-1).content, big(30_000), '最近一条必须原文保留');
  assert.equal(toolMessages.at(-3).content, big(30_000), '最近三条必须原文保留');
  assert.equal(toolMessages.at(-4).content, COMPACTED_OUTPUT, '更早的一条应被压缩');
  assert.equal(messages[0].content, '规则', '系统规则不能被改写');
});

test('预算充足时不改写任何消息', () => {
  const messages = [{ role: 'tool', tool_call_id: 'a', content: big(500) }];
  const result = compactToolHistory(messages);
  assert.deepEqual(result, { compacted: 0, length: big(500).length });
  assert.equal(messages[0].content, big(500));
});

test('Responses 协议的 function_call_output 同样被压缩', () => {
  const messages = [];
  for (let i = 0; i < 6; i++) messages.push({ type: 'function_call_output', call_id: `c${i}`, output: big(40_000) });
  const result = compactToolHistory(messages, { budget: 100_000, keepRecent: 1 });
  assert.ok(result.compacted >= 3);
  assert.equal(messages[0].output, COMPACTED_OUTPUT);
  assert.equal(messages.at(-1).output, big(40_000));
});

test('不动非工具消息，即使正文很长', () => {
  const long = big(200_000);
  const messages = [{ role: 'user', content: long }, { role: 'tool', tool_call_id: 'a', content: big(40_000) }];
  compactToolHistory(messages, { budget: 1000, keepRecent: 0 });
  assert.equal(messages[0].content, long, '用户正文不属于可压缩的工具输出');
});
