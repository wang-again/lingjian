import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,access,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {OfficeService} from '../lib/office.mjs';
import {createTestApp,listenHttp} from './fixtures/http.mjs';
import {runOfficeAgent} from '../lib/office-agent.mjs';
import {validateProvider} from '../lib/providers.mjs';
import { integrationMissing } from './fixtures/office-runtime.mjs';

const project=resolve('.');
const fixtures=join(project,'tests/fixtures/office');
const python=process.env.OFFICE_PYTHON||join(project,'.venv-office',process.platform==='win32'?'Scripts/python.exe':'bin/python');
async function cleanup(path){assert.equal(dirname(resolve(path)),resolve(tmpdir()));assert.ok(basename(path).startsWith('yanzhi-office-test-'));await rm(path,{recursive:true,force:true,maxRetries:10,retryDelay:100});}

test('DOCX 版式预览校验文件边界和转换器状态，并渲染真实中文 PDF 页面',{skip:integrationMissing},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'yanzhi-office-test-')),app=await createTestApp({dataDir:directory});
  t.after(async()=>{await app.close();await cleanup(directory);});
  const bootstrap=await (await fetch(`${app.url}/api/bootstrap`)).json();
  const bytes=await readFile(join(project,'resources/templates/zh-notice-document.docx'));
  const upload=await app.office.upload('通知.docx',bytes.toString('base64'));
  const post=body=>fetch(`${app.url}/api/office/docx-preview`,{method:'POST',
    headers:{'Content-Type':'application/json','X-Workspace-Token':bootstrap.token},body:JSON.stringify(body)});
  assert.equal((await post({id:'../../outside.docx'})).status,400);
  assert.equal((await post({id:upload.id,start:0})).status,400);
  const originalExecutable=process.env.LINGJIAN_SOFFICE_PATH;
  try {
    process.env.LINGJIAN_SOFFICE_PATH=join(directory,'missing-soffice.exe');
    const unavailable=await post({id:upload.id});
    assert.equal(unavailable.status,503);
    assert.match((await unavailable.json()).error,/LibreOffice/);
  } finally {
    if(originalExecutable===undefined)delete process.env.LINGJIAN_SOFFICE_PATH;
    else process.env.LINGJIAN_SOFFICE_PATH=originalExecutable;
  }
  const file=await app.office.safePath(upload.id);
  assert.deepEqual(await readFile(file),bytes);
  for(const name of ['zh-notice-print.pdf','zh-work-plan-print.pdf']){
    const pdf=join(project,'resources/templates',name);
    const {stdout}=await promisify(execFile)(python,['-X','utf8',join(project,'tools/render_docx_preview.py'),pdf,'1']);
    const result=JSON.parse(stdout);
    assert.ok(result.total>0);assert.equal(result.pages[0].page,1);
    assert.equal(Buffer.from(result.pages[0].png,'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  }
});

test('Office 真实工具集成：读写编辑四种格式、路径边界与副本保护',{skip:integrationMissing,timeout:90000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'yanzhi-office-test-')),office=new OfficeService(directory,{python});
  t.after(async()=>{office.close();await cleanup(directory);});
  const status=await office.status();assert.equal(status.available,true,status.error);assert.equal(status.count,35);
  assert.ok(status.tools.some(tool=>tool.name==='preview_document_edits'));
  const uploaded={};for(const extension of ['docx','xlsx','pptx','pdf','png','txt'])uploaded[extension]=await office.upload(`示例.${extension}`,(await readFile(join(fixtures,`sample.${extension}`))).toString('base64'));
  await t.test('读取 Word、Excel、PPT、PDF 和图片，正文能导入编辑器',async()=>{
    const word=await office.extract(uploaded.docx.id);assert.ok(word.text.includes('原始内容待补充'));assert.ok(word.html.includes('<table>'));assert.ok(word.html.includes('<h2>'));
    const excel=await office.extract(uploaded.xlsx.id);assert.ok(excel.text.includes('120'));assert.ok(excel.html.includes('第一阶段'));
    const ppt=await office.extract(uploaded.pptx.id);assert.ok(ppt.text.includes('Office 集成验证'));
    const pdf=await office.extract(uploaded.pdf.id);assert.ok(pdf.text.includes('Office integration PDF sample'));
    const image=await office.call('read_image',{image_path:uploaded.png.id});assert.equal(image.images.length,1);assert.ok(image.images[0].data.length>50);
  });
  await t.test('Word 导入保留交错表格顺序、基础样式、换行与清单', async () => {
    const file = join(directory, 'ordered.docx');
    await promisify(execFile)(python, ['-c', `
import sys
from docx import Document
doc = Document()
doc.add_heading('Section', 1)
p = doc.add_paragraph()
p.add_run('Before').italic = True
p.add_run().add_break()
p.add_run('Underlined').underline = True
table = doc.add_table(rows=1, cols=2)
table.cell(0, 0).paragraphs[0].add_run('Inside').bold = True
table.cell(0, 1).text = 'Other cell'
doc.add_paragraph('After', style='Quote')
doc.add_paragraph('First item', style='List Number')
doc.add_paragraph('Second item', style='List Number')
doc.add_paragraph('Bullet item', style='List Bullet')
doc.save(sys.argv[1])
`, file], { windowsHide: true });
    const upload = await office.upload('ordered.docx', (await readFile(file)).toString('base64'));
    const result = await office.extract(upload.id);
    assert.match(result.html, /<h2>.*Section.*<\/h2><p><em>Before<\/em><br><u>Underlined<\/u><\/p><table>/);
    assert.match(result.html, /<th><p><strong>Inside<\/strong><\/p><\/th>/);
    assert.match(result.html, /<\/table><blockquote>.*After.*<\/blockquote><ol><li>First item<\/li><li>Second item<\/li><\/ol><ul><li>Bullet item<\/li><\/ul>$/);
    assert.equal(result.text, 'Section\nBefore\nUnderlined\nInside\tOther cell\nAfter\nFirst item\nSecond item\nBullet item');
  });
  await t.test('编辑 Word 自动另存副本，原文件字节保持不变',async()=>{
    const original=await readFile(await office.safePath(uploaded.docx.id));
    const result=await office.call('edit_docx',{file_path:uploaded.docx.id,spec_json:JSON.stringify({operations:[{op:'replace_all',find:'待补充',replace:'已确认'}]})});
    assert.equal(result.data.success,true);assert.notEqual(result.data.output,`./${uploaded.docx.id}`);
    assert.deepEqual(await readFile(await office.safePath(uploaded.docx.id)),original);
    const edited=await office.extract(result.data.output);assert.ok(edited.text.includes('已确认'));
  });
  await t.test('创建 Excel 并编辑副本、创建 PPT 均产生可再次读取的文件',async()=>{
    await office.call('write_xlsx',{output:'generated.xlsx',sheets_json:JSON.stringify([{name:'计划',headers:['阶段','预算'],rows:[['初稿',500]]}])});
    const updated=await office.call('edit_xlsx',{file_path:'generated.xlsx',spec_json:JSON.stringify({operations:[{op:'set_cell',cell:'B2',value:900}]})});
    const sheet=await office.call('read_xlsx',{file_path:updated.data.output});assert.ok(JSON.stringify(sheet.data).includes('900'));
    await office.call('write_pptx',{output:'generated.pptx',slides_json:JSON.stringify([{layout:0,title:'集成验收',subtitle:'生成成功'},{layout:1,title:'关键能力',bullets:['读取','编辑','导出']}])});
    const ppt=await office.call('read_pptx',{file_path:'generated.pptx',mode:'outline'});assert.equal(ppt.data.slide_count,2);
  });
  await t.test('PDF 修改、保存和页面预览在同一 MCP 进程内完成',async()=>{
    await assert.rejects(office.call('pdf_save',{filepath:uploaded.pdf.id}),/没有待保存的 PDF 修改/);
    await office.call('pdf_highlight_area',{filepath:uploaded.pdf.id,page_num:1,bbox:[45,45,260,65]});
    const saved=await office.call('pdf_save',{filepath:uploaded.pdf.id});assert.equal(saved.data.success,true);
    const rendered=await office.call('pdf_render_pages',{filepath:saved.data.output_path,page_range:'1',dpi:72});assert.equal(rendered.data.length,1);
    await access(await office.safePath(rendered.data[0].image_path));
  });
  await t.test('设计版 PPT 可生成中文预览图片',async()=>{
    const result=await office.call('write_pptx_design',{output:'design.pptx',spec_json:JSON.stringify({slides:[{id:'s1',bg:{cover:true},items:[{t:'title',x:112,y:210,w:1250,h:120,s:'文档工作台集成验证',size:36,color:'5EA0FF'}]}]})});
    assert.equal(result.data.success,true);assert.ok(result.data.previews.length);await access(await office.safePath(result.data.previews[0]));
  });
  await t.test('嵌套输出和图片路径不能越界；覆盖前有备份；智能体不能删除',async()=>{
    await assert.rejects(office.call('read_docx',{file_path:'../../outside.docx'}),/文件库/);
    await assert.rejects(office.call('edit_docx',{file_path:uploaded.docx.id,spec_json:JSON.stringify({output:join(directory,'outside.docx'),operations:[]})}),/文件库/);
    await assert.rejects(office.call('write_pptx',{output:'escape.pptx',slides_json:JSON.stringify([{image:{path:'../../outside.png'}}])}),/文件库/);
    await assert.rejects(office.call('write_pptx_design',{output:'escape.pptx',spec_json:JSON.stringify({slides:[{id:'../../escape',items:[]}]})}),/ID/);
    await assert.rejects(office.call('delete_file',{path:uploaded.txt.id},{agent:true}),/不能调用/);
    await office.call('write_file',{path:'draft.txt',content:'before'});await office.call('write_file',{path:'draft.txt',content:'after'});
    assert.ok((await readdir(office.backups)).some(name=>name.endsWith('_draft.txt')));
    const outside=join(directory,'outside');await mkdir(outside);await symlink(outside,join(office.root,'linked'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(office.safePath('linked/secret.txt'),/文件库外/);
  });
});

test('Office HTTP 和模型工具调用：Chat/Responses 均执行真实 Word 工具后返回文件',{skip:integrationMissing,timeout:90000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'yanzhi-office-test-')),app=await createTestApp({dataDir:directory});
  const requests=[];
  const mock=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);requests.push(input);
    const responses=req.url.endsWith('/responses'),history=responses?input.input:input.messages;
    const hasOutput=history.some(item=>item.role==='tool'||item.type==='function_call_output');
    res.writeHead(200,{'Content-Type':'application/json'});
    const args = JSON.stringify({ output: `${responses ? 'responses' : 'chat'}-result.docx`, title: '工具重试验收', content_json: '[{"type":"paragraph","text":"真实生成内容"}]' });
    const ids = ['call-first', 'call-repeat'];
    if(responses)res.end(JSON.stringify({status:'completed',output:hasOutput?[{type:'message',role:'assistant',content:[{type:'output_text',text:'已通过工具生成 Word 文件。'}]}]:ids.map(call_id => ({type:'function_call',call_id,name:'write_docx',arguments:args}))}));
    else res.end(JSON.stringify({choices:[{finish_reason:hasOutput?'stop':'tool_calls',message:hasOutput?{role:'assistant',content:'已通过工具生成 Word 文件。'}:{role:'assistant',content:null,tool_calls:ids.map(id => ({id,type:'function',function:{name:'write_docx',arguments:args}}))}}]}));
  });await listenHttp(mock);
  t.after(async()=>{await app.close();await new Promise(resolve=>{mock.closeAllConnections();mock.close(resolve);});await cleanup(directory);});
  const boot=await(await fetch(`${app.url}/api/bootstrap`)).json();
  const request=(path,body)=>fetch(`${app.url}${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-Token':boot.token},body:JSON.stringify(body)});
  await t.test('编辑器导入四种格式保存为独立正文，文件库原件逐字节保留', async () => {
    for (const [format, expected] of [['docx', '原始内容待补充'], ['xlsx', '第一阶段'], ['pptx', 'Office 集成验证'], ['pdf', 'Office integration PDF sample']]) {
      const bytes = await readFile(join(fixtures, `sample.${format}`));
      const uploaded = await request('/api/office/upload', { name: `sample.${format}`, base64: bytes.toString('base64') });
      assert.equal(uploaded.status, 201);
      const { file } = await uploaded.json();
      const extracted = await request('/api/office/extract', { id: file.id });
      assert.equal(extracted.status, 200);
      const { html } = await extracted.json();
      assert.ok(html.includes(expected));
      const saved = await request('/api/documents', { title: `导入验收 ${format}`, html, sources: [] });
      assert.equal(saved.status, 201);
      assert.equal((await saved.json()).document.html, html);
      const original = await fetch(`${app.url}/api/office/file?id=${encodeURIComponent(file.id)}`);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    }
  });
  const upload=await(await request('/api/office/upload',{name:'参考.txt',base64:Buffer.from('实际参考资料').toString('base64')})).json();assert.ok(upload.file.id.endsWith('.txt'));
  const extracted=await(await request('/api/office/extract',{id:upload.file.id})).json();assert.equal(extracted.text,'实际参考资料');
  assert.equal((await fetch(`${app.url}/api/office/file?id=../../workspace.json`)).status,400);
  for(const protocol of ['chat','responses']){
    const config=validateProvider({name:'模拟模型',model:'fixture-model',protocol,baseUrl:`http://127.0.0.1:${mock.address().port}/v1`});const events=[];
    const result=await runOfficeAgent(config,'test-not-real-key',app.office,{prompt:'生成 Word 验收文件',files:[]},{onEvent:(kind,data)=>events.push({kind,data})});
    assert.equal(result.calls,2);assert.ok(events.some(event=>event.kind==='step'&&event.data.ok===true));assert.ok(events.some(event=>event.kind==='delta'));
    assert.deepEqual(await readdir(app.office.backups), [], '重复的生成指令不能覆盖产物并产生写入备份');
    assert.equal(events.filter(event => event.kind === 'check').length, 1);
    assert.equal(result.checks.length,1);assert.equal(result.checks[0].status,'passed');
    assert.equal(result.checks[0].visual_review,false);assert.ok(events.some(event=>event.kind==='check'));
    const doc=await app.office.extract(`${protocol}-result.docx`);assert.ok(doc.text.includes('真实生成内容'));
    const returned=requests.at(-1);assert.equal(returned.stream,protocol==='chat');assert.ok(!returned.tools.some(tool=>(tool.name||tool.function?.name)==='delete_file'));
  }
  const response=await fetch(`${app.url}/api/office/file?id=chat-result.docx`);assert.equal(response.status,200);assert.ok(response.headers.get('content-disposition').startsWith('attachment'));
});
