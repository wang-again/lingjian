import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createSkillRuntime } from '../lib/agent-skills.mjs';
import { runOfficeAgent } from '../lib/office-agent.mjs';
import { integrationMissing } from './fixtures/office-runtime.mjs';
import { runWritingTask } from '../lib/writing.mjs';
import { OfficeService } from '../lib/office.mjs';
import { validateProvider } from '../lib/providers.mjs';
import { listenHttp } from './fixtures/http.mjs';

const python = process.env.OFFICE_PYTHON || resolve('.venv-office', process.platform==='win32'?'Scripts/python.exe':'bin/python');
function reply(res, responses, calls=[], text='准备完成') {
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(JSON.stringify(responses ? {status:'completed',output:calls.length?calls.map((call,i)=>({type:'function_call',call_id:`id-${i}`,name:call.name,arguments:JSON.stringify(call.args)})):[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]} : {choices:[{finish_reason:calls.length?'tool_calls':'stop',message:calls.length?{role:'assistant',content:null,tool_calls:calls.map((call,i)=>({id:`id-${i}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))}:{role:'assistant',content:text}}]}));
}
async function service(t, handler) {
  const server=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part; await handler(JSON.parse(body),res,req.url.endsWith('/responses'));});
  await listenHttp(server);t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
async function workspace(t) {
  const directory=await mkdtemp(join(tmpdir(),'yanzhi-autonomy-')),office=new OfficeService(directory,{python});
  t.after(async()=>{office.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('yanzhi-autonomy-'));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});return office;
}

test('模型技能运行时按调用加载、可组合、重复加载幂等，拒绝越界技能',async()=>{
  const state=createSkillRuntime('office');assert.equal(state.instructions,'');
  await state.activate({skill_id:'source-synthesis'});await state.activate({skill_id:'report-writing'});await state.activate({skill_id:'report-writing'});
  assert.equal(state.active.size,2);assert.ok(state.instructions.includes('content_json'));
  await assert.rejects(state.activate({skill_id:'../../other'}));
  await assert.rejects(createSkillRuntime('writing').activate({skill_id:'docx-delivery'}));
});

test('模型自主组合技能、调整工具失败并交付 Word，文件权限不能通过技能扩大',{skip:integrationMissing,timeout:90000},async t=>{
  const office=await workspace(t),source=await office.upload('依据.txt',Buffer.from('预算 100 元').toString('base64')),hidden=await office.upload('未选中.txt',Buffer.from('unselected-secret-content').toString('base64'));
  const requests=[];
  const baseUrl=await service(t,(input,res,responses)=>{
    requests.push(input);const history=responses?input.input:input.messages,outputs=history.filter(item=>item.role==='tool'||item.type==='function_call_output');
    const n=outputs.length;
    const calls=n===0?[{name:'use_skill',args:{skill_id:'source-synthesis'}},{name:'use_skill',args:{skill_id:'report-writing'}}]
      :n===2?[{name:'read_file',args:{path:hidden.id}}]
      :n===3?[{name:'read_file',args:{path:source.id}}]
      :n===4?[{name:'write_docx',args:{output:`auto-${responses}.docx`,title:'预算报告',content_json:'[{"type":"paragraph","text":"预算为 100 元。[资料：依据.txt]"}]'}}]:[];
    reply(res,responses,calls,'报告已生成。');
  });
  for(const protocol of ['chat','responses']){
    const events=[];const config=validateProvider({name:'自主模型',model:'fixture',protocol,baseUrl});
    const result=await runOfficeAgent(config,'',office,{prompt:'根据资料生成 Word 文件',files:[source]},{onEvent:(kind,data)=>events.push({kind,data})});
    assert.equal(result.checks[0].status,'passed');assert.ok(events.some(event=>event.kind==='delta'));
    const history=protocol==='responses'?requests.at(-1).input:requests.at(-1).messages;
    assert.ok(history[0].content.includes('任务技能：资料归纳'));assert.ok(history[0].content.includes('任务技能：报告撰写'));
    assert.ok(JSON.stringify(history).includes('只能读取本次选中的资料'));assert.ok(!JSON.stringify(history).includes('unselected-secret-content'));
    assert.ok(!requests.at(-1).tools.some(tool=>(tool.name||tool.function?.name)==='delete_file'));
  }
});

test('主写作入口由模型自主移交实际文件任务，返回下载产物',{skip:integrationMissing,timeout:90000},async t=>{
  const office=await workspace(t);const requests=[];
  const baseUrl=await service(t,(input,res,responses)=>{
    requests.push(input);const names=input.tools?.map(tool=>tool.name||tool.function?.name)||[];
    const history=responses?input.input:input.messages,outputs=history.filter(item=>item.role==='tool'||item.type==='function_call_output');
    if(names.includes('process_files'))return reply(res,responses,[{name:'process_files',args:{request:'把正文生成 Word 文件'}}]);
    if(outputs.length===0)return reply(res,responses,[{name:'use_skill',args:{skill_id:'report-writing'}}]);
    if(outputs.length===1)return reply(res,responses,[{name:'write_docx',args:{output:`handoff-${responses}.docx`,content_json:'[{"type":"paragraph","text":"保留正文事实：预算为100元。"}]'}}]);
    reply(res,responses,[],'文件已生成。');
  });
  for(const protocol of ['chat','responses']){
    const events=[];const result=await runWritingTask(validateProvider({name:'自主',model:'fixture',protocol,baseUrl}),'',{title:'预算',html:'<p>预算为100元</p>',sources:[]},{mode:'write',prompt:'把当前正文生成可下载的 Word 文件'},{office,onEvent:(kind,data)=>events.push({kind,data})});
    assert.equal(result.fileTask,true);
    assert.ok(events.findIndex(event=>event.kind==='delivery'&&event.data.fileTask) >= 0);
    assert.ok(events.findIndex(event=>event.kind==='delivery') < events.findIndex(event=>event.kind==='delta'), '文件移交必须先于文字输出，避免文件摘要覆盖正文');
    assert.ok(events.some(event=>event.kind==='files'&&event.data.files.some(file=>file.id.endsWith('.docx'))));
    assert.ok(events.filter(event=>event.kind==='files').every(event=>event.data.files.every(file=>!file.id.endsWith('.json'))));
    assert.ok(JSON.stringify(requests).includes('预算为100元'));
  }
});

test('未安装 Office 时保留普通写作、技能选择和草稿流式输出',async t=>{
  const toolDirectory = join(tmpdir(), `lingjian-uninstalled-${crypto.randomUUID()}`);
  const office = new OfficeService(tmpdir(), { toolDirectory });
  const status = await office.status();
  assert.equal(status.available, false);
  assert.match(status.error, /可选 Office 工具/);
  const requests=[];const baseUrl=await service(t,(input,res,responses)=>{
    requests.push(input);const history=responses?input.input:input.messages;
    if(input.tools){const used=history.some(item=>item.role==='tool'||item.type==='function_call_output');return reply(res,responses,used?[]:[{name:'use_skill',args:{skill_id:'source-synthesis'}}]);}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end(responses?'data: {"type":"response.output_text.delta","delta":"归纳正文"}\n\ndata: {"type":"response.completed"}\n\n':'data: {"choices":[{"delta":{"content":"归纳正文"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  for(const protocol of ['chat','responses']){
    const result=await runWritingTask(validateProvider({name:'自主',model:'fixture',protocol,baseUrl}),'',{title:'资料',html:'<p>事实</p>',sources:[]},{mode:'write',prompt:'归纳正文'},{office});
    assert.equal(result,'归纳正文');const messages=protocol==='responses'?requests.at(-1).input:requests.at(-1).messages;
    assert.ok(messages[0].content.includes('任务技能：资料归纳'));
  }
  assert.ok(requests.flatMap(request => request.tools || []).every(tool => (tool.function?.name || tool.name) !== 'process_files'));
});
