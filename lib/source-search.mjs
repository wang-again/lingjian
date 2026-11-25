import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './providers.mjs';

export const sourceSearchTool = {
  name: 'search_sources', description: '在指定本地资料中检索关键词，返回原文片段、文件名及真实段落/页码/工作表单元格/幻灯片位置和引用标记。query 中以空格分隔的关键词按任一词匹配。仅检索所选文件；不是全文审阅，不执行 OCR 或联网查询。',
  inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: '要检索的文件库相对 ID，最多 20 个' }, query: { type: 'string', description: '关键词或短语，空格分隔多个关键词' }, limit: { type: 'integer', default: 12, minimum: 1, maximum: 50 } }, required: ['files', 'query'], additionalProperties: false }
};

export async function searchSources(office, args) {
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200) throw new UserError('检索词应为 1–200 字。');
  if (!Array.isArray(args.files) || !args.files.length || args.files.length > 20 || args.files.some(id => typeof id !== 'string')) throw new UserError('请指定 1–20 个要检索的文件 ID。');
  const limit = args.limit ?? 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new UserError('返回数量应为 1–50 的整数。');
  const files = [];
  for (const id of new Set(args.files)) {
    if (!['.docx', '.pdf', '.xlsx', '.xlsm', '.pptx', '.txt', '.md', '.csv'].includes(extname(id).toLowerCase())) throw new UserError('检索支持 Word、PDF、Excel、PPT、TXT、Markdown 和 CSV。');
    const path = await office.safePath(id), info = await stat(path);
    if (!info.isFile() || info.size > 20_000_000) throw new UserError('每个检索文件应不超过 20 MB。');
    const canonicalId = office.relativePath(path);
    files.push({ path, id: canonicalId, name: office.labels[canonicalId] || canonicalId });
  }
  const data = await new Promise((resolve, reject) => {
    const child = spawn(office.python, ['-X', 'utf8', fileURLToPath(new URL('../tools/search_sources.py', import.meta.url))], { cwd: office.root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new UserError('资料检索超过 30 秒，请减少文件或拆分资料。', 504)); }, 30000);
    child.on('error', () => finish(new UserError('无法启动本地资料检索，请检查 Python 环境。', 503)));
    child.stdin.on('error', () => finish(new UserError('资料检索连接中断。', 503)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', part => { output += part; if (output.length > 1_000_000) { child.kill(); finish(new UserError('检索结果过大，请缩小范围。', 502)); } });
    child.on('close', code => {
      if (code !== 0) return finish(new UserError('资料检索未能完成，请检查格式及 Office 依赖。', 502));
      try { finish(null, JSON.parse(output)); } catch { finish(new UserError('资料检索返回了无效数据。', 502)); }
    });
    child.stdin.end(JSON.stringify({ files, query: args.query.trim(), limit }));
  });
  return { data, images: [], files: await office.listFiles() };
}
