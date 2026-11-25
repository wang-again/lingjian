// Isolated UI QA fixture. It never calls a paid provider or uses a real API key.
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server.mjs';
const service = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  if (input.model === 'qa-auth-error') {
    res.writeHead(401, { 'Content-Type': 'application/json', 'x-request-id': 'qa-auth-trace' });
    res.end(JSON.stringify({ error: { code: 'InvalidApiKey', message: '模拟鉴权失败，请核对密钥与地域。' } })); return;
  }
  if (!input.tools && input.messages?.at(-1)?.content === '请只回复：连接成功') {
    if (!input.stream) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'InvalidParameter', message: 'parameter.enable_thinking only support stream call' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"reasoning_content":"hidden-qa-reasoning"}}]}\n\ndata: {"choices":[{"delta":{"content":"连接成功（仅流式模拟模型）"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return;
  }
  if (input.tools) {
    const history = input.messages || input.input || [];
    const outputs = history.filter(item => item.role === 'tool' || item.type === 'function_call_output');
    let context = {};
    for (const item of history) {
      if (item.role !== 'user' || typeof item.content !== 'string') continue;
      try { const parsed = JSON.parse(item.content); if (Array.isArray(parsed.selectedFiles)) context = parsed; } catch {}
    }
    const names=input.tools.map(tool=>tool.name||tool.function?.name);
    const userPrompt=context.request||history.filter(item=>item.role==='user'&&typeof item.content==='string').at(-1)?.content||'';
    const inspection = /检查/.test(userPrompt)&&!/生成/.test(userPrompt);
    const loaded=outputs.some(item=>{try{return !!JSON.parse(item.content||item.output).loaded;}catch{return false;}});
    const operations=outputs.filter(item=>{try{return !JSON.parse(item.content||item.output).loaded;}catch{return true;}});
    const files = inspection ? (context.selectedFiles || []).filter(file => /\.docx$/i.test(file.id)) : context.selectedFiles || [];
    let call;
    if(names.includes('submit_consistency_review')) {
      const source=context.document,find=text=>source.find(item=>item.text===text),quote=item=>({location:item.location,quote:item.text});
      const canonical=find('口径说明：项目总预算以100万元为准。'),target=find('项目总预算为200万元。'),a=find('项目计划在2026年12月31日验收。'),b=find('项目计划在2027年1月31日验收。');
      const operations=/只列问题/.test(userPrompt)?[]:[{type:'replace_text',location:target.location,find:'200',replace:'100',reason:'按文内明确基准统一预算'}];
      call={name:'submit_consistency_review',arguments:{source_sha256:context.source_sha256,summary:'一致性检查结果',findings:[
        {category:'amount',title:'项目总预算金额冲突',explanation:'同一项目总预算出现100万元与200万元两个金额。',suggestion:'按文内明确口径统一为100万元。',evidence:[quote(canonical),quote(target)],basis:{kind:'document_evidence',location:canonical.location,quote:'项目总预算以100万元为准'},operations},
        {category:'date',title:'验收日期待确认',explanation:'同一项目有两个验收日期，文内未给出哪个为准。',suggestion:'核对项目计划后确认日期。',evidence:[quote(a),quote(b)],operations:[]}
      ]}};
    }
    else if(names.includes('submit_document_review')) {
      const spreadsheet=/\.xlsx$/i.test(context.selectedFiles[0].id),slides=/\.pptx$/i.test(context.selectedFiles[0].id),tables=!spreadsheet&&!slides&&/表格|单元格/.test(userPrompt),paragraphs=!spreadsheet&&!slides&&!tables&&/段落|拆分|插入/.test(userPrompt);
      if(!outputs.length)call={name:'inspect_document',arguments:{file_path:context.selectedFiles[0].id,query:spreadsheet?'':slides?'预算':paragraphs||tables?'':'100',include_tables:tables,limit:100,...(spreadsheet?{sheet_name:'预算表',cell_range:'B2:C2'}:{})}};
      else if(outputs.length===1){const snapshot=JSON.parse(outputs[0].content||outputs[0].output);let operations=snapshot.locations.slice(0,2).map(item=>({location:item.location,find:'100',replace:'200',reason:'按要求将金额从100调整为200。'}));
        if(paragraphs){const op=(text,type,replace)=>({location:snapshot.locations.find(item=>item.text===text).location,find:text,type,replace,reason:'按要求调整段落结构。'});operations=[op('项目费用100元。','insert_after','补充说明：预算经审批后执行。'),op('项目背景。方案目标。','split_paragraph','项目背景。\n方案目标。'),op('待删除的段落。','delete_paragraph','')];}
        if(tables){const op=(entry,type,replace)=>({location:entry.location,find:entry.text,type,replace,reason:'按要求调整表格。'}),row=n=>snapshot.locations.find(item=>item.section==='表格行'&&item.table===1&&item.row===n),cell=snapshot.locations.find(item=>item.section==='表格单元格'&&item.table===1&&item.row===3&&item.column===3);operations=[op(cell,'set_cell_text','完成'),op(row(2),'insert_row_after',JSON.stringify(['新增','300','进行中'])),op(row(4),'delete_row','')];}
        if(spreadsheet)operations=snapshot.locations.map(item=>({location:item.location,find:item.text,replace:item.cell==='B2'?'500':'完成',value_type:item.cell==='B2'?'number':'string',type:'set_spreadsheet_cell',reason:'按要求更新预算与状态。'}));
        if(slides)operations=snapshot.locations.map(item=>({location:item.location,find:'100',replace:'200',type:'replace_slide_text',reason:'按要求更新预算文字。'}));
        call={name:'submit_document_review',arguments:{source_sha256:snapshot.source_sha256,summary:spreadsheet?'建议更新预算数字与状态文字。':slides?'建议修改两页预算文字。':tables?'建议填写空白状态、增加一条明细并删除过期行。':paragraphs?'建议插入一段说明、拆分背景与目标，并删除指定段落。':'建议调整两处金额，请逐条确认。',operations}};}
    }
    else if(names.includes('process_files')&&/Word|DOCX|文件/.test(userPrompt)){call={name:'process_files',arguments:{request:'根据当前正文生成 Word 文件'}};}
    else if(names.includes('use_skill')&&!loaded){call={name:'use_skill',arguments:{skill_id:inspection?'docx-delivery':'report-writing'}};}
    else if(names.length===1&&names[0]==='use_skill'){}
    else if (operations.length < files.length) {
      const id = files[operations.length].id;
      const name = inspection ? 'check_docx' : /\.docx$/i.test(id) ? 'read_docx' : /\.xlsx?m?$/i.test(id) ? 'read_xlsx' : /\.pptx$/i.test(id) ? 'read_pptx' : /\.pdf$/i.test(id) ? 'pdf_extract_text' : /\.(png|jpe?g|webp)$/i.test(id) ? 'read_image' : 'read_file';
      const key = name === 'read_file' ? 'path' : name === 'read_image' ? 'image_path' : name === 'pdf_extract_text' ? 'filepath' : 'file_path';
      call = { name, arguments: { [key]: id } };
    } else if (!inspection && operations.length === files.length) {
      call = { name:'write_docx', arguments:{output:`智能体摘要_${Date.now()}.docx`,title:'Office 智能体验收',content_json:JSON.stringify([{type:'heading',text:'一、集成成果'},{type:'paragraph',text:'工作台已集成 Word、Excel、PPT、PDF 工具，可使用自配模型执行文件任务。本文件正文来自本地模拟模型，仅用于界面验收。'}]),overwrite:true} };
    }
    const message = call ? {role:'assistant',content:null,tool_calls:[{id:`office-qa-${outputs.length}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]} : {role:'assistant',content:inspection ? '已执行 DOCX 交付检查，请查看实际检查结果。' : '文件已生成，可直接下载。'};
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(input.input ? JSON.stringify({status:'completed',output:call ? [{type:'function_call',call_id:`office-qa-${outputs.length}`,name:call.name,arguments:JSON.stringify(call.arguments)}] : [{type:'message',role:'assistant',content:[{type:'output_text',text:message.content}]}]}) : JSON.stringify({choices:[{finish_reason:call?'tool_calls':'stop',message}]}));
    return;
  }
  if (!input.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '连接成功（本地模拟接口）' }, finish_reason: 'stop' }] })); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const parts = ['## 一、项目目标\n', '打造支持自配 API 的文档工作台。\n\n', '## 二、实施计划\n', '1. 配置模型接口并测试连接。\n', '2. 选择模板，结合参考资料编写。\n', '3. 审阅草稿后应用并导出。\n\n', '| 阶段 | 交付物 |\n| --- | --- |\n| 第一阶段 | 可运行的文档工作台 |'];
  let index = 0;
  const timer = setInterval(() => {
    if (index >= parts.length) { clearInterval(timer); res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":60}}\n\ndata: [DONE]\n\n'); }
    else res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[index++] }, finish_reason: null }] })}\n\n`);
  }, 250);
  res.on('close', () => clearInterval(timer));
});
await new Promise(resolve => service.listen(3212, '127.0.0.1', resolve));
const app = await createApp({ authMode: 'local', port: 3211, dataDir: await mkdtemp(join(tmpdir(), 'yanzhi-ui-')) });
app.store.state.providers=[{id:'office-qa-model',name:'本地验收模型（模拟接口）',model:'qa-test-model',protocol:'chat',baseUrl:'http://127.0.0.1:3212/v1',maxTokens:4096,timeout:30,tokenField:'max_tokens',temperature:null,stream:true}];
app.store.state.activeProviderId='office-qa-model';await app.store.persist();
await app.office.call('write_docx',{output:'修改建议验收.docx',title:'修改建议验收',content_json:JSON.stringify([{type:'paragraph',text:'项目费用100元。'},{type:'paragraph',text:'审批额度100元。'},{type:'paragraph',text:'项目背景。方案目标。'},{type:'paragraph',text:'待删除的段落。'}])});
await app.office.call('write_docx',{output:'表格修改验收.docx',title:'表格修改验收',content_json:JSON.stringify([{type:'table',headers:['项目','金额','状态'],rows:[['参考','100','待定'],['填写','200',''],['删除','400','过期']]}])});
await app.office.call('write_xlsx',{output:'Excel修改验收.xlsx',sheets_json:JSON.stringify([{name:'预算表',headers:['项目','预算','状态'],rows:[['甲',100,'待定']]}])});
await app.office.call('write_pptx',{output:'PPT修改验收.pptx',slides_json:JSON.stringify([{layout:1,title:'预算100元',bullets:['保留说明']},{layout:1,title:'预算100元',bullets:['保留第二页']}])});
await app.office.call('write_docx',{output:'一致性检查验收.docx',title:'一致性检查验收',content_json:JSON.stringify(['口径说明：项目总预算以100万元为准。','项目总预算为200万元。','项目计划在2026年12月31日验收。','项目计划在2027年1月31日验收。'].map(text=>({type:'paragraph',text})))});
console.log(`UI QA: ${app.url}\nMock API: http://127.0.0.1:3212/v1`);
