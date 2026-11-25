import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runModel, modelToolTurn, createIdleGuard, UserError } from '../lib/providers.mjs';

const baseConfig = port => ({ baseUrl: `http://127.0.0.1:${port}`, model: 'm', protocol: 'chat', tokenField: 'max_tokens', maxTokens: 1000, timeout: 0.4, temperature: null, stream: true });

async function upstream(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('上游持续出字时按空闲计时，不会因总时长被切断', async () => {
  const { port, close } = await upstream(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < 8; i++) {
      await wait(100);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '字' } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  try {
    const text = await runModel(baseConfig(port), '', [{ role: 'user', content: 'x' }]);
    assert.equal(text, '字'.repeat(8), '每个 100ms 出字、空闲阈值 400ms，应完整收完 800ms 的流');
  } finally { await close(); }
});

test('上游静默超过空闲阈值时返回 504 并说明是“没有收到新数据”', async () => {
  const { port, close } = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': open\n\n');
    // 之后不再发送任何数据，模拟上游卡死。
  });
  try {
    await assert.rejects(runModel(baseConfig(port), '', [{ role: 'user', content: 'x' }]), error => {
      assert.equal(error.status, 504);
      assert.match(error.message, /没有收到新的数据/);
      assert.equal(error.diagnostic.category, 'timeout');
      return true;
    });
  } finally { await close(); }
});

test('工具轮同样按空闲计时，慢速分片的工具调用不会被截断', async () => {
  const { port, close } = await upstream(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'use_skill' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"skill_' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'id":"report-writing"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ];
    for (const chunk of chunks) { await wait(150); res.write(`data: ${JSON.stringify(chunk)}\n\n`); }
    res.write('data: [DONE]\n\n'); res.end();
  });
  try {
    const turn = await modelToolTurn(baseConfig(port), '', [{ role: 'user', content: 'x' }], [{ name: 'use_skill', description: 'd', inputSchema: { type: 'object' } }]);
    assert.equal(turn.calls.length, 1);
    assert.equal(turn.calls[0].name, 'use_skill');
    assert.equal(turn.calls[0].arguments, '{"skill_id":"report-writing"}');
  } finally { await close(); }
});

test('总时长上限仍然生效，防止持续滴数据的连接永久占用', async () => {
  const guard = createIdleGuard(60, { totalMs: 220 });
  for (let i = 0; i < 10; i++) { if (guard.reason()) break; await wait(40); guard.touch(); }
  const reason = guard.reason();
  guard.dispose();
  assert.equal(reason, 'total', '一直有数据但超过总上限时，应标记为 total 而不是 idle');
});

test('外部取消优先于空闲计时，返回 499', async () => {
  const { port, close } = await upstream((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  try {
    await assert.rejects(runModel(baseConfig(port), '', [{ role: 'user', content: 'x' }], { signal: controller.signal }), error => {
      assert.ok(error instanceof UserError);
      assert.equal(error.status, 499);
      assert.match(error.message, /任务已取消/);
      return true;
    });
  } finally { await close(); }
});
