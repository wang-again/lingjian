// 统一的 SSE 通道：写入响应头、心跳、客户端断开即中止上游、结束时清理监听。
// 生成正文与 Office 智能体此前各写了一份，行为已经分叉；此处收口到一处。
export function openEventStream(res, { heartbeatMs = 15_000 } = {}) {
  const controller = new AbortController();
  let finished = false;

  const onClose = () => { if (!res.writableEnded) controller.abort('client-closed'); };
  res.on('close', onClose);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();

  const heartbeat = heartbeatMs ? setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
  }, heartbeatMs) : null;
  heartbeat?.unref?.();

  const event = (type, data) => {
    if (res.destroyed || res.writableEnded) return false;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  const close = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    res.off('close', onClose);
    if (!res.destroyed && !res.writableEnded) res.end();
  };

  return { event, close, signal: controller.signal, aborted: () => controller.signal.aborted };
}
