import { mkdir, open, unlink, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const BUSY = '此数据目录已被服务或迁移工具锁定。请先停止现有实例；若上次异常退出，可在确认进程已结束后删除 .data/.service.lock 再启动。';

// 锁文件写入 pid 却从不校验，会让异常退出后的目录永久锁死。
// 只有「pid 明确不存在」或「锁文件损坏且已过宽限期」才接管，避免和正在启动的实例抢锁。
async function stale(file) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { parsed = null; }
  if (Number.isInteger(parsed?.pid) && parsed.pid > 0) {
    try { process.kill(parsed.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }
  try { return Date.now() - (await stat(file)).mtimeMs > 10_000; }
  catch { return false; }
}

export async function acquireDataLock(directory) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, '.service.lock');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!await stale(file)) throw new Error(BUSY);
    await unlink(file).catch(() => {});
    try { handle = await open(file, 'wx', 0o600); }
    catch (retry) { throw retry.code === 'EEXIST' ? new Error(BUSY) : retry; }
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  catch (error) { await handle.close(); await unlink(file); throw error; }
  let released;
  return () => released ||= (async () => { await handle.close(); await unlink(file); })();
}
