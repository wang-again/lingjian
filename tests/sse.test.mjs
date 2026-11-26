import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openEventStream } from '../lib/sse.mjs';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false; this.writableEnded = false;
    this.status = 0; this.headers = null; this.chunks = []; this.endCalls = 0;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  flushHeaders() { this.flushed = true; }
  write(chunk) { this.chunks.push(chunk); return true; }
  end() { this.writableEnded = true; this.endCalls++; }
}

test('打开事件流时写入正确的响应头与事件格式', () => {
  const res = new FakeResponse();
  const stream = openEventStream(res, { heartbeatMs: 0 });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  assert.ok(res.flushed);

  assert.equal(stream.event('step', { text: '进行中' }), true);
  assert.equal(res.chunks[0], 'event: step\ndata: {"text":"进行中"}\n\n');

  stream.close();
  assert.equal(stream.event('done', { ok: true }), false, '关闭后不再写数据');
  assert.equal(res.chunks.length, 1);
});

test('客户端断开时中止上游信号，供模型请求与工具调用取消', () => {
  const res = new FakeResponse();
  const stream = openEventStream(res, { heartbeatMs: 0 });
  assert.equal(stream.aborted(), false);
  res.emit('close');
  assert.equal(stream.aborted(), true);
  assert.equal(stream.signal.aborted, true);
  stream.close();
});

test('心跳按间隔写入，关闭后立即停止且只结束一次', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = new FakeResponse();
  const stream = openEventStream(res, { heartbeatMs: 15 });
  t.mock.timers.tick(14);
  assert.deepEqual(res.chunks, []);
  t.mock.timers.tick(1);
  t.mock.timers.tick(15);
  assert.deepEqual(res.chunks, [': heartbeat\n\n', ': heartbeat\n\n']);

  stream.close();
  stream.close();
  assert.equal(res.endCalls, 1, 'close 必须幂等');
  const after = res.chunks.length;
  t.mock.timers.tick(30);
  assert.equal(res.chunks.length, after, '关闭后不应再写心跳');
});
