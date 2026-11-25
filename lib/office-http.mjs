import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { UserError } from './providers.mjs';
import { runOfficeAgent } from './office-agent.mjs';
import { htmlToText } from './prompts.mjs';
import { createDocumentReview, applyDocumentReview } from './document-review.mjs';
import { createConsistencyReview } from './consistency.mjs';
import { openEventStream } from './sse.mjs';

export async function handleOffice({req,res,url,send,readJson,office,providers,secrets,documents,assertProvider = () => {},keyForProvider = config => secrets.get(config.id) || ''}) {
  const path = url.pathname;
  if (!path.startsWith('/api/office/')) return false;
  if (req.method === 'GET' && path === '/api/office/status') { send(200,await office.status()); return true; }
  if (req.method === 'GET' && path === '/api/office/files') { send(200,{files:await office.listFiles()}); return true; }
  if (req.method === 'GET' && path === '/api/office/file') {
    await office.prepare();
    const target = await office.safePath(url.searchParams.get('id') || '');
    const info = await stat(target).catch(error => { if (error.code === 'ENOENT') throw new UserError('文件不存在。', 404); throw error; });
    if (!info.isFile() || info.size > 30_000_000) throw new UserError('该文件不是可下载文件，或超过 30 MB。');
    const image = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[extname(target).toLowerCase()];
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.writeHead(200,{'Content-Type':image || 'application/octet-stream','Content-Disposition':`${image && url.searchParams.get('inline') === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(target))}`});
    res.end(await readFile(target)); return true;
  }
  if (req.method === 'POST' && path === '/api/office/upload') {
    const input = await readJson(req,29_000_000); send(201,{file:await office.upload(input.name,input.base64),files:await office.listFiles()}); return true;
  }
  if (req.method === 'POST' && path === '/api/office/call') {
    const input = await readJson(req); send(200,await office.call(input.name,input.arguments)); return true;
  }
  if (req.method === 'POST' && path === '/api/office/extract') {
    const input = await readJson(req); send(200,await office.extract(input.id)); return true;
  }
  if (req.method === 'POST' && path === '/api/office/review/apply') {
    send(200, await applyDocumentReview(office, await readJson(req))); return true;
  }
  if (req.method === 'POST' && path === '/api/office/agent') {
    const input = await readJson(req), config = providers.find(item=>item.id === input.providerId);
    if (!config) throw new UserError('请先配置并选择支持工具调用的模型。');
    assertProvider(config);
    if (!Array.isArray(input.files) || input.files.length > 20 || input.files.some(id=>typeof id !== 'string')) throw new UserError('一次最多选择 20 个文件。');
    const allFiles = await office.listFiles(), selected = input.files.map(id=>allFiles.find(file=>file.id === id));
    if (selected.some(file=>!file)) throw new UserError('部分选中文件已不存在，请刷新文件库。');
    if ((input.review||input.consistency) && (selected.length !== 1 || !/\.(docx|pdf|xlsx|pptx)$/i.test(selected[0].id))) throw new UserError('请只选择一份 DOCX、文字型 PDF、XLSX 或 PPTX 检查或生成建议。');
    const document = input.includeDocument ? documents.find(item=>item.id===input.documentId) : null;
    const stream = openEventStream(res), event = stream.event;
    try {
      if(input.consistency) {
        const review=await createConsistencyReview(config,keyForProvider(config),office,{prompt:input.prompt??'',file:selected[0]},{signal:stream.signal,onEvent:event});
        event('done',{ok:true,reviewRequired:Boolean(review.findings.length)});return true;
      }
      if (input.review) {
        const review = await createDocumentReview(config,keyForProvider(config),office,{prompt:input.prompt,file:selected[0]},{signal:stream.signal,onEvent:event});
        event('done',{ok:true,reviewRequired:Boolean(review)});
        return true;
      }
      const result = await runOfficeAgent(config,keyForProvider(config),office,{prompt:input.prompt,skillId:input.skillId,files:selected.map(({id,name})=>({id,name})),document:document ? `${document.title}\n${htmlToText(document.html)}` : ''},{signal:stream.signal,onEvent:event});
      event('done',{ok:true,reviewRequired:result.reviewRequired});
    } catch (error) { event('error',{message:error.message}); }
    finally {stream.close();}
    return true;
  }
  throw new UserError('没有找到这个 Office 接口。',404);
}
