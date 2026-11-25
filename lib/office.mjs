import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, readdir, stat, lstat, realpath, copyFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, extname, basename, sep } from 'node:path';
import { officePython, officeSetupMessage, officeToolDirectory, officeToolInstalled } from './runtime.mjs';
import { UserError } from './providers.mjs';
import { docxCheckTool, inspectDocx } from './docx-inspection.mjs';
import { sourceSearchTool, searchSources } from './source-search.mjs';
import { assertJsonBudget } from './json-guard.mjs';

const pathKeys = new Set(['file_path', 'filepath', 'path', 'output', 'output_path', 'output_dir', 'source', 'destination', 'image_path']);
const basicTools = new Set(['write_docx', 'write_xlsx', 'list_directory', 'read_file', 'write_file', 'edit_file', 'file_info', 'create_directory', 'move_file', 'delete_file']);
const integrationTools = ['inspect_document', 'preview_document_edits', 'edit_document', 'ocr_document'];
const compatibleTools = new Set([...basicTools, ...integrationTools,
  'read_docx', 'edit_docx', 'read_xlsx', 'edit_xlsx', 'read_pptx', 'write_pptx', 'edit_pptx', 'write_pptx_design',
  'pdf_info', 'pdf_extract_text', 'pdf_render_pages', 'pdf_apply_modifications', 'pdf_save', 'pdf_manual_replace_text',
  'pdf_redact', 'pdf_highlight_area', 'pdf_add_text', 'pdf_deyellow', 'read_image']);
const jsonKeys = new Set(['spec_json', 'content_json', 'sheets_json', 'slides_json', 'modifications_json']);
const readonly = new Set(['preview_document_edits','ocr_document','inspect_document','read_docx','read_xlsx','read_pptx','read_file','file_info','list_directory','read_image','pdf_info','pdf_extract_text','pdf_render_pages']);
export const isOfficeWrite = name => !readonly.has(name) && !['check_docx', 'search_sources', 'use_skill'].includes(name);
export const agentExcluded = new Set(['delete_file', 'move_file']);
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

function wordHtml(blocks) {
  const html = [];
  let list = null;
  const closeList = () => {
    if (list) html.push(`</${list.tag}>`);
    list = null;
  };
  for (const block of blocks) {
    if (block.kind === 'table') {
      closeList();
      const rows = block.rows.map((row, index) => {
        const tag = index === 0 ? 'th' : 'td';
        return `<tr>${row.map(cell => `<${tag}>${wordHtml(cell)}</${tag}>`).join('')}</tr>`;
      });
      html.push(`<table><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }
    const content = block.runs.map(run => {
      let text = escape(run.text).replaceAll('\n', '<br>');
      for (const [style, tag] of [['bold', 'strong'], ['italic', 'em'], ['underline', 'u'], ['strike', 's']]) {
        if (run[style]) text = `<${tag}>${text}</${tag}>`;
      }
      return text;
    }).join('');
    if (block.list) {
      const tag = block.list.ordered ? 'ol' : 'ul';
      if (list?.key !== block.list.key || list?.tag !== tag) {
        closeList();
        html.push(`<${tag}>`);
        list = { key: block.list.key, tag };
      }
      html.push(`<li>${content}</li>`);
      continue;
    }
    closeList();
    const style = `${block.style} ${block.style_name}`;
    const heading = /(?:Heading|标题)\s*([1-9])/i.exec(style)?.[1];
    const tag = heading ? `h${Math.min(4, Number(heading) + 1)}` : /\b(?:Intense\s*)?Quote\b|引用/i.test(style) ? 'blockquote' : 'p';
    html.push(`<${tag}>${content}</${tag}>`);
  }
  closeList();
  return html.join('');
}

function wordText(blocks) {
  return blocks.map(block => block.kind === 'table'
    ? block.rows.map(row => row.map(wordText).join('\t')).join('\n')
    : block.runs.map(run => run.text).join('')).join('\n');
}

export class OfficeService {
  constructor(dataDir, { python = officePython(), toolDirectory = officeToolDirectory(), backupMaxFiles = 20, backupMaxBytes = 500 * 1024 * 1024 } = {}) {
    this.directory = join(dataDir, 'office'); this.root = join(this.directory, 'files'); this.backups = join(this.directory, 'backups');
    this.backupMaxFiles = backupMaxFiles; this.backupMaxBytes = backupMaxBytes;
    this.toolDirectory = toolDirectory; this.extended = false;
    this.python = python; this.pending = new Map(); this.nextId = 0; this.worker = null; this.starting = null; this.tools = []; this.labels = {}; this.queue = Promise.resolve();this.prepared=false;this.preparing=null;this.labelTail=Promise.resolve();
  }
  // 备份只用于“写坏了还能找回原件”，不是版本库：超出份数或体积上限时淘汰最旧的。
  async pruneBackups({ maxFiles = this.backupMaxFiles, maxBytes = this.backupMaxBytes } = {}) {
    await this.prepare();
    let entries;
    try { entries = await readdir(this.backups, { withFileTypes: true }); } catch { return { count: 0, bytes: 0, removed: 0 }; }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(this.backups, entry.name);
      try { const info = await stat(path); files.push({ path, size: info.size, mtime: info.mtimeMs }); } catch {}
    }
    files.sort((a, b) => b.mtime - a.mtime);
    let count = 0, bytes = 0, removed = 0;
    for (const [index, file] of files.entries()) {
      // 最新一份永远保留：即便单个文件就超过体积上限，也不能把刚做的备份立刻删掉。
      if (index === 0 || (count < maxFiles && bytes + file.size <= maxBytes)) { count++; bytes += file.size; continue; }
      try { await unlink(file.path); removed++; } catch {}
    }
    return { count, bytes, removed };
  }
  async backupUsage() {
    await this.prepare();
    let entries = [];
    try { entries = await readdir(this.backups, { withFileTypes: true }); } catch {}
    let count = 0, bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try { const info = await stat(join(this.backups, entry.name)); count++; bytes += info.size; } catch {}
    }
    return { count, bytes };
  }
  async prepare() {
    if(this.prepared)return;if(this.preparing)return this.preparing;
    this.preparing=(async()=>{
      await mkdir(this.root, { recursive: true }); await mkdir(this.backups, { recursive: true });
      this.root = await realpath(this.root);
      try { this.labels = JSON.parse(await readFile(join(this.directory, 'labels.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.prepared=true;
    })().finally(()=>{this.preparing=null;});
    return this.preparing;
  }
  async safePath(value = '.') {
    if (typeof value !== 'string' || value.includes('\0') || value.length > 1500) throw new UserError('文件路径不正确。');
    const target = resolve(this.root, value);
    const inside = path => { const rel = relative(this.root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
    if (!inside(target)) throw new UserError('文件路径必须位于工作台文件库内。');
    let ancestor = target;
    while (true) {
      try { if (!inside(await realpath(ancestor))) throw new UserError('文件路径通过链接指向了文件库外。'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(ancestor); if (parent === ancestor) throw new UserError('文件路径不正确。'); ancestor = parent; }
    }
    return target;
  }
  relativePath(path) { return relative(this.root, path).split(sep).join('/'); }
  request(method, params = {}, timeout = 180_000) {
    const worker = this.worker;
    if (!worker?.stdin.writable) return Promise.reject(new UserError('Office 工具进程尚未就绪。', 503));
    const id = ++this.nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.close(); reject(new UserError('Office 工具响应超时，进程已重置。已落盘的文件会保留，请先检查文件库再重试。', 504)); }, timeout);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new UserError('Office 工具连接已断开。', 503)); } });
    });
  }
  isConfigured() { return officeToolInstalled(this.toolDirectory); }

  async start() {
    if (this.starting) return this.starting;
    if (this.worker && this.tools.length) return;
    this.starting = (async () => {
      if (!await this.isConfigured()) throw new UserError(officeSetupMessage, 503);
      await this.prepare();
      const scratch = join(this.root, '_scratch'); await mkdir(scratch, { recursive: true });
      const workerEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|INVITE/i.test(name)));
      const worker = spawn(this.python, ['-u', join(this.toolDirectory, 'server.py')], {
        cwd: this.root, windowsHide: true, stdio: ['pipe','pipe','pipe'],
        env: { ...workerEnv, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', OFFICE_TOOLS_ALLOWED_DIRS: this.root, TEMP: scratch, TMP: scratch, TMPDIR: scratch }
      });
      this.worker = worker; let diagnostics = '';
      worker.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2500); });
      const fail = message => {
        if (this.worker !== worker) return;
        this.worker = null; this.tools = [];
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new UserError(message, 503)); }
        this.pending.clear();
      };
      worker.on('error', () => fail('Office 运行环境未安装。请运行「安装Office依赖.cmd」后重新连接。'));
      worker.stdin.on('error',()=>fail('Office 工具输入连接已断开，请重新连接。'));
      worker.on('exit', () => fail(`Office 工具进程已退出。请检查依赖后重试。${diagnostics.includes('ModuleNotFoundError') ? '缺少 Python 依赖，请运行安装脚本。' : ''}`));
      createInterface({ input: worker.stdout, crlfDelay: Infinity }).on('line', line => {
        let response; try { response = JSON.parse(line); } catch { return; }
        const request = this.pending.get(response.id); if (!request) return;
        clearTimeout(request.timer); this.pending.delete(response.id);
        if (response.error) request.reject(new UserError(response.error.message || 'Office 工具请求失败。', 502)); else request.resolve(response.result);
      });
      await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lingjian-document-studio', version: '0.2.0' } }, 30_000);
      worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const result = await this.request('tools/list', {}, 30_000);
      const tools = result.tools || [];
      this.extended = integrationTools.every(name => tools.some(tool => tool.name === name));
      const allowed = this.extended ? compatibleTools : basicTools;
      this.tools = tools.filter(({ name }) => allowed.has(name));
      if (!this.tools.length) throw new UserError('安装的 Office 工具未提供兼容的功能。', 503);
    })().catch(error => { this.close(); throw error; }).finally(() => { this.starting = null; });
    return this.starting;
  }
  close() {
    const worker = this.worker; this.worker = null; this.tools = [];
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new UserError('Office 工具连接已关闭。', 503)); }
    this.pending.clear(); worker?.stdin.destroy(); worker?.kill();
  }
  async status() {
    try { await this.start(); const tools = [...this.tools, docxCheckTool, sourceSearchTool]; return { available: true, tools, fileRoot: this.root, version: this.extended ? 'compatible-local' : 'upstream-local', count: tools.length, backups: await this.backupUsage() }; }
    catch (error) { return { available: false, tools: [], count: 0, error: error.message }; }
  }
  async listFiles() {
    await this.prepare(); const files = [];
    const walk = async (directory, depth = 0) => {
      if (depth > 4 || files.length >= 500) return;
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.name.startsWith('_') || item.name.startsWith('.')) continue;
        const path = join(directory, item.name); if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) await walk(path, depth + 1);
        else if (item.isFile()) { const info = await stat(path), id = this.relativePath(path); files.push({ id, name: this.labels[id] || item.name, size: info.size, extension: extname(item.name).toLowerCase(), modifiedAt: info.mtime.toISOString() }); }
      }
    };
    await walk(this.root); return files.sort((a,b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
  async upload(name, base64) {
    await this.prepare();
    if (typeof name !== 'string' || name.length > 200 || typeof base64 !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64)) throw new UserError('上传内容格式不正确。');
    const extension = extname(name).toLowerCase();
    if (!['.docx','.xlsx','.xlsm','.pptx','.pdf','.txt','.md','.csv','.png','.jpg','.jpeg','.webp'].includes(extension)) throw new UserError('支持 Word、Excel、PPT、PDF、文本和图片文件。');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > 20_000_000) throw new UserError('单个文件应为非空文件，且不超过 20 MB。');
    const stem = basename(name, extension).replace(/[^\p{L}\p{N}_-]/gu,'_').slice(0,65) || 'file';
    const id = `${stem}_${crypto.randomUUID().slice(0,8)}${extension}`;
    await writeFile(await this.safePath(id), bytes, { flag: 'wx' }); this.labels[id] = name;
    this.labelTail=this.labelTail.catch(()=>{}).then(async()=>{const temporary=join(this.directory,`labels.${crypto.randomUUID()}.tmp`);await writeFile(temporary,JSON.stringify(this.labels),'utf8');await rename(temporary,join(this.directory,'labels.json'));});
    await this.labelTail;
    return { id, name, extension, size: bytes.length };
  }
  async mapArguments(value, key = '') {
    if (pathKeys.has(key) && typeof value === 'string' && value) return this.safePath(value);
    if (jsonKeys.has(key) && typeof value === 'string') {
      let parsed; try { parsed = JSON.parse(value); } catch { throw new UserError(`${key} 必须是合法 JSON。`); }
      assertJsonBudget(parsed, { label: key });
      return JSON.stringify(await this.mapArguments(parsed));
    }
    if (Array.isArray(value)) return Promise.all(value.map(item => this.mapArguments(item)));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [name, item] of Object.entries(value)) result[name] = await this.mapArguments(item, name);
      return result;
    }
    return value;
  }
  call(name, args = {}, { agent = false, generated } = {}) {
    const task = this.queue.catch(() => {}).then(() => this.execute(name,args,agent,generated)); this.queue = task; return task;
  }
  async execute(name, args, agent, generated) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new UserError('工具参数必须是 JSON 对象。');
    assertJsonBudget(args, { label: '工具参数', maxDepth: 12 });
    if (name === 'check_docx') { await this.prepare(); return inspectDocx(this, args); }
    if (name === 'search_sources') { await this.prepare(); return searchSources(this, args); }
    await this.start();
    if (!this.tools.some(tool => tool.name === name) || (agent && agentExcluded.has(name))) throw new UserError('当前任务不能调用这个 Office 工具。');
    const input = await this.mapArguments(args);
    if (name === 'write_pptx_design') {
      const spec = JSON.parse(input.spec_json || '{}');
      for (const slide of spec.slides || []) if (slide.id && !/^[a-zA-Z0-9_-]{1,80}$/.test(slide.id)) throw new UserError('幻灯片 ID 只能包含英文、数字、下划线和短横线。');
    }
    if (['edit_document','edit_docx','edit_xlsx','edit_pptx'].includes(name)) {
      const spec = JSON.parse(input.spec_json || '{}');
      if (!spec.output || spec.output === input.file_path) {
        const extension = extname(input.file_path); spec.output = input.file_path.slice(0,-extension.length) + `_edited_${crypto.randomUUID().slice(0,8)}` + extension;
      }
      input.spec_json = JSON.stringify(spec);
    }
    if (name === 'pdf_render_pages' && !input.output_dir) input.output_dir = await this.safePath(`previews_${crypto.randomUUID().slice(0,8)}`);
    if (name === 'pdf_render_pages' && (Number(input.dpi || 200) > 300 || Number(input.dpi || 200) < 36)) throw new UserError('预览分辨率需在 36–300 DPI 之间。');
    if (name === 'pdf_save' && !input.output_path) input.output_path = input.filepath.replace(/\.pdf$/i,`_modified_${crypto.randomUUID().slice(0,8)}.pdf`);
    const edits = ['edit_document','edit_docx','edit_xlsx','edit_pptx'].includes(name);
    const specOutput = edits ? JSON.parse(input.spec_json).output : null;
    const targets = [input.output, input.output_path, specOutput, ...(['write_file','edit_file','delete_file'].includes(name) ? [input.path] : []), ...(name === 'move_file' ? [input.source,input.destination] : [])].filter(Boolean);
    if (agent) {
      const destinations = name === 'pdf_render_pages' ? [input.output_dir] : targets;
      for (const path of destinations) {
        if (name !== 'pdf_render_pages' && generated?.has(this.relativePath(path))) continue;
        try {
          await lstat(path);
          throw new UserError('智能体只能创建新文件或更新本次任务生成的文件，请另存。');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (!readonly.has(name)) {
      let copied = false;
      for (const path of targets) {
        try {
          const info = await stat(path);
          if (info.isDirectory() && ['delete_file','move_file'].includes(name)) throw new UserError('当前集成仅支持移动或删除单个文件；目录请在文件管理器中整理。');
          if (info.isFile()) { await copyFile(path, join(this.backups, `${crypto.randomUUID()}_${basename(path)}`)); copied = true; }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (copied) await this.pruneBackups();
    }
    const result = await this.request('tools/call', { name, arguments: input });
    if (result.isError) throw new UserError((result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Office 工具执行失败。', 422);
    const content = result.content || [], texts = content.filter(item => item.type === 'text').map(item => item.text);
    let data = texts.join('\n'); try { data = JSON.parse(data); } catch {}
    if (data?.error || data?.success === false) throw new UserError(data.error || 'Office 工具报告执行失败。',422);
    // Return workspace-relative paths so the model and UI cannot confuse host paths.
    const localize = (value,key='') => {
      if (typeof value === 'string' && (pathKeys.has(key)||['file','previews'].includes(key))) {
        const normalized=resolve(this.root,value),rel=relative(this.root,normalized);
        if(rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel)))return this.relativePath(normalized)||'.';
      }
      if (Array.isArray(value)) return value.map(item=>localize(item,key));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,localize(v,k)]));
      return value;
    };
    return { data: localize(data), images: content.filter(item => item.type === 'image').map(item => ({ data: item.data, mimeType: item.mimeType })), files: await this.listFiles() };
  }
  async extract(id) {
    const path = await this.safePath(id), extension = extname(path).toLowerCase(); let html = '', text = '', warnings = [];
    if (extension === '.docx') {
      const { data } = await this.call('read_docx', { file_path: id, mode: 'editor' });
      html = wordHtml(data.blocks);
      text = wordText(data.blocks);
      warnings.push('已按原文顺序导入正文、标题和表格。复杂版式、合并或嵌套表格、图片和脚注适合在原文件中查看。');
    } else if (['.xlsx','.xlsm'].includes(extension)) {
      const { data } = await this.call('read_xlsx',{file_path:id,mode:'full'});
      html = `<h2>${escape(data.sheet_name || data.sheet || '工作表')}</h2>` + this.tableHtml(data.data || []);
      text = JSON.stringify(data,null,2); warnings.push('当前提取第一个工作表；可通过工具的 sheet_name 参数读取其他工作表。公式不在本工具内重算。');
    } else if (extension === '.pptx') {
      const { data } = await this.call('read_pptx',{file_path:id,mode:'outline'});
      html = (data.slides || []).map(slide=>`<h2>第 ${slide.slide_num} 页 · ${escape(slide.title || '')}</h2><ul>${(slide.bullets || []).map(item=>`<li>${escape(item.text)}</li>`).join('')}</ul>`).join('');
      text = (data.slides || []).map(slide=>`${slide.title || ''}\n${(slide.bullets || []).map(item=>item.text).join('\n')}`).join('\n\n');
    } else if (extension === '.pdf') {
      const { data } = await this.call('pdf_extract_text',{filepath:id});
      const scanned = data.filter(page=>!page.text.trim()).map(page=>page.page);
      if (scanned.length) {
        const recognized = (await this.call('ocr_document',{file_path:id,page_range:scanned.join(',')})).data;
        for (const page of data) { const ocr=recognized.pages.find(item=>item.page===page.page); if(ocr)page.text=ocr.text; }
        warnings.push(...recognized.warnings);
      }
      text = data.map(page=>`第 ${page.page} 页\n${page.text}`).join('\n\n');
      html = data.map(page=>`<h2>第 ${page.page} 页</h2><p>${escape(page.text).replaceAll('\n','<br>')}</p>`).join('');
      if (!data.some(page=>page.text.trim())) throw new UserError('未识别到文字，请检查扫描清晰度或使用更清晰的文件。');
    } else if (['.png','.jpg','.jpeg','.webp'].includes(extension)) {
      const { data } = await this.call('ocr_document',{file_path:id});
      text=data.text;html=`<p>${escape(text).replaceAll('\n','<br>')}</p>`;warnings.push(...data.warnings);
      if (!data.pages.some(page=>page.text.trim())) throw new UserError('图片未识别到文字，请上传更清晰的原图。');
    } else if (['.txt','.md','.csv'].includes(extension)) {
      text = await readFile(path,'utf8'); html = `<p>${escape(text).replaceAll('\n','<br>')}</p>`;
    } else throw new UserError('该类型支持作为文件保存或预览，暂不能转为正文。');
    if (text.length > 300_000 || html.length > 900_000) throw new UserError('提取内容超过单次导入上限，请拆分文件后导入。');
    return { title: basename(this.labels[id] || id,extension), html, text, warnings };
  }
  tableHtml(rows) { return `<table><tbody>${rows.map((row,i)=>`<tr>${row.map(cell=>`<${i?'td':'th'}>${escape(cell)}</${i?'td':'th'}>`).join('')}</tr>`).join('')}</tbody></table>`; }
}
