import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { UserError } from './providers.mjs';

const execute = promisify(execFile);
const renderer = fileURLToPath(new URL('../tools/render_docx_preview.py', import.meta.url));
const runningPreviews = new WeakSet();

function libreOffice() {
  if (process.env.LINGJIAN_SOFFICE_PATH) return process.env.LINGJIAN_SOFFICE_PATH;
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const candidate = join(root, 'LibreOffice', 'program', 'soffice.com');
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'soffice';
}

export async function previewDocx(office, { id, start = 1 }, { signal } = {}) {
  if (typeof id !== 'string' || extname(id).toLowerCase() !== '.docx') throw new UserError('请选择一个 DOCX 文件预览。');
  if (!Number.isSafeInteger(start) || start < 1) throw new UserError('预览起始页应为正整数。');
  await office.prepare();
  const source = await office.safePath(id);
  const info = await stat(source).catch(error => {
    if (error.code === 'ENOENT') throw new UserError('文件不存在。', 404);
    throw error;
  });
  if (!info.isFile() || info.size > 20_000_000) throw new UserError('仅支持预览 20 MB 以内的 DOCX 文件。');
  if (runningPreviews.has(office)) throw new UserError('已有版式预览正在生成，请稍后再试。', 429);
  runningPreviews.add(office);
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'lingjian-docx-'));
    const profile = join(directory, 'profile');
    const input = join(directory, 'document.docx');
    const output = join(directory, 'document.pdf');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|INVITE/i.test(name)));
    const options = { cwd: directory, env, windowsHide: true, timeout: 30_000, maxBuffer: 12_000_000, signal };
    await copyFile(source, input);
    await mkdir(join(profile, 'user'), { recursive: true });
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'),
      '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>');
    try {
      await execute(libreOffice(), [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', directory, input], options);
    } catch (error) {
      if (signal?.aborted) throw new UserError('版式预览已停止。', 499);
      if (error.code === 'ENOENT') throw new UserError('版式预览需要本机安装 LibreOffice。安装后可重试，结构检查仍可使用。', 503);
      throw new UserError('DOCX 转 PDF 未完成，文件可能损坏或转换超时。', 422);
    }
    const pdf = await stat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!pdf?.isFile() || pdf.size > 30_000_000) throw new UserError('未生成可预览的 PDF，或预览超过 30 MB。', 422);
    try {
      const result = await execute(office.python, ['-X', 'utf8', renderer, output, String(start)], options);
      const preview = JSON.parse(result.stdout);
      if (!preview.pages.length) throw new UserError('起始页超出文档页数。');
      return preview;
    } catch (error) {
      if (signal?.aborted) throw new UserError('版式预览已停止。', 499);
      if (error instanceof UserError) throw error;
      throw new UserError('无法渲染预览页，请检查本地 Office 依赖。', 422);
    }
  } finally {
    runningPreviews.delete(office);
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  }
}
