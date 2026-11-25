import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UserError } from './providers.mjs';

const execute = promisify(execFile);
export const docxCheckTool = {
  name: 'check_docx', description: '实际检查 DOCX 文件结构、正文、必要章节、占位符及表格声明宽度，保存 JSON 检查报告。不修改原文；不代表已完成页面渲染、事实或计算核验。',
  inputSchema: { type: 'object', properties: { file_path: { type: 'string', description: '文件库中的 DOCX 相对 ID' }, required_sections: { type: 'array', items: { type: 'string' }, description: '用户明确要求的章节名；未指定时留空', default: [] } }, required: ['file_path'], additionalProperties: false }
};

// 检查脚本理论上只输出 JSON；一旦依赖库往 stdout 打了警告，这里必须给出可读错误而不是 500。
export function parseCheckReport(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new UserError('DOCX 检查脚本返回了无法解析的报告，请检查 Office 依赖是否完整。', 502);
  }
}

export async function inspectDocx(office, args) {
  if (typeof args.file_path !== 'string' || !/\.docx$/i.test(args.file_path)) throw new UserError('请选择一个 DOCX 文件进行检查。');
  const sections = args.required_sections ?? [];
  if (!Array.isArray(sections) || sections.length > 50 || sections.some(item => typeof item !== 'string' || !item.trim() || item.length > 100)) throw new UserError('必要章节应为最多 50 个非空名称，每个不超过 100 字。');
  const path = await office.safePath(args.file_path), info = await stat(path);
  if (!info.isFile() || info.size > 30_000_000) throw new UserError('DOCX 文件应不超过 30 MB。');
  let output;
  try {
    output = await execute(office.python, ['-X', 'utf8', fileURLToPath(new URL('../skills/docx-delivery/scripts/check_docx.py', import.meta.url)), path, JSON.stringify(sections)], { cwd: office.root, windowsHide: true, timeout: 30000, maxBuffer: 1_000_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  } catch (error) {
    throw new UserError(error.code === 'ENOENT' ? 'DOCX 检查需要 Python，请安装 Office 依赖后重试。' : 'DOCX 检查进程未能完成，请检查文件大小和 Python 环境。', 503);
  }
  const report = { ...parseCheckReport(output.stdout), sha256: createHash('sha256').update(await readFile(path)).digest('hex'), file: office.relativePath(path), report_file: `${office.relativePath(path).replace(/\.docx$/i, '')}.check_${crypto.randomUUID().slice(0, 8)}.json` };
  await writeFile(await office.safePath(report.report_file), JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
  return { data: report, images: [], files: await office.listFiles() };
}
