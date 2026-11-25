import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { integrationMissing } from './fixtures/office-runtime.mjs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { OfficeService } from '../lib/office.mjs';
import http from 'node:http';
import { runOfficeAgent } from '../lib/office-agent.mjs';
import { validateProvider } from '../lib/providers.mjs';
import { listenHttp } from './fixtures/http.mjs';
const python=process.env.OFFICE_PYTHON || resolve('.venv-office',process.platform==='win32'?'Scripts/python.exe':'bin/python');
test('Word/PDF 精确修改真实格式与完整性，工具通过现有文件库工作', {skip: integrationMissing,timeout:60000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lingjian-edit-test-'));
  const office=new OfficeService(directory,{python});
  t.after(async()=>{office.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('lingjian-edit-test-'));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await promisify(execFile)(python,[resolve('tests/fixtures/editing_regression.py'),join(directory,'fixtures')],{windowsHide:true});
  const file=await office.upload('原件.docx',(await readFile(join(directory,'fixtures/source.docx'))).toString('base64'));
  const snapshot=await office.call('inspect_document',{file_path:file.id,query:'100'});
  const result=await office.call('edit_document',{file_path:file.id,spec_json:JSON.stringify({source_sha256:snapshot.data.source_sha256,operations:[{location:snapshot.data.locations[0].location,find:'100',replace:'500'}]})});
  assert.notEqual(result.data.output,file.id); assert.equal(result.data.changed_count,1);
  assert.ok(!result.data.output.includes(office.root));
  await assert.rejects(office.call('edit_document',{file_path:file.id,spec_json:JSON.stringify({source_sha256:snapshot.data.source_sha256,output:'../../escape.docx',operations:[]})}),/文件库/);
  let pretend = false;
  const mock=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const input=JSON.parse(body),responses=req.url.endsWith('/responses');
    const history=responses?input.input:input.messages;
    const outputs=history.filter(item=>item.role==='tool'||item.type==='function_call_output');
    let call;
    if(!pretend && !outputs.length) call={name:'inspect_document',args:{file_path:file.id,query:'100'}};
    else if(!pretend && outputs.length===1){const read=JSON.parse(outputs[0].content||outputs[0].output);call={name:'edit_document',args:{file_path:file.id,spec_json:JSON.stringify({source_sha256:read.source_sha256,operations:[{location:read.locations[0].location,find:'100',replace:'600'}]})}};}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(responses?{status:'completed',output:call?[{type:'function_call',call_id:`c${outputs.length}`,name:call.name,arguments:JSON.stringify(call.args)}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'修改已完成。'}]}]}:{choices:[{finish_reason:call?'tool_calls':'stop',message:call?{role:'assistant',tool_calls:[{id:`c${outputs.length}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}:{role:'assistant',content:'修改已完成。'}}]}));
  });
  await listenHttp(mock);t.after(()=>new Promise(resolve=>{mock.closeAllConnections();mock.close(resolve);}));
  for(const protocol of ['chat','responses']){
    const config=validateProvider({name:'验收',model:'fixture',protocol,baseUrl:`http://127.0.0.1:${mock.address().port}/v1`});
    const events=[];
    const result=await runOfficeAgent(config,'',office,{prompt:'把正文中的100修改为600，保留原格式',files:[file]},{onEvent:(kind,data)=>events.push({kind,data})});
    assert.equal(result.edits.length,1); assert.equal(result.checks.length,1);
    assert.ok(events.some(event=>event.kind==='delta' && event.data.text.includes('修改核对')));
    pretend=true;
    await assert.rejects(runOfficeAgent(config,'',office,{prompt:'修改 Word 文字',files:[file]}),/尚未完成要求的文档修改/);
    pretend=false;
  }
});
